package service

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path"
	"runtime"
	"strings"
	"sync"
	"time"

	"welfare/model"

	"gorm.io/gorm"
)

const (
	FeedbackMaxImages         = 3
	FeedbackMaxImageBytes     = 5 * 1024 * 1024
	FeedbackMaxMultipartBytes = 16 * 1024 * 1024
	FeedbackMaxPayloadBytes   = 32 * 1024
	feedbackStoreMarker       = "welfare-feedback-images-v1\n"
	feedbackStoreMarkerName   = ".feedback-image-store"
	feedbackOrphanGrace       = 24 * time.Hour
)

var (
	ErrFeedbackImageLimit         = errors.New("最多 3 张图片，每张不超过 5 MiB；尺寸不超过 8192 像素和 2000 万像素")
	ErrFeedbackRequestLimit       = errors.New("请求不能超过 16 MiB，留言参数不能超过 32 KiB")
	ErrFeedbackImageFormat        = errors.New("仅支持完整的静态 JPG、PNG 或 WebP 图片，不支持动图")
	ErrFeedbackImageStore         = errors.New("图片服务暂不可用，请稍后重试")
	ErrFeedbackSubmissionConflict = errors.New("本次发送标识已用于其他内容，请重新发送")
)

// FeedbackImageStore never exposes a static directory. SQL authorization must
// precede OpenImage. The guard spans staging, finalization and SQL publication,
// so cleanup cannot delete an active attempt even if clocks change.
type FeedbackImageStore struct {
	root       *os.Root
	guard      sync.RWMutex
	processing chan struct{}
	// Keep an open directory cursor between bounded passes, including within
	// one prefix. Old referenced entries cannot starve later orphan objects.
	cleanupDir     *os.File
	cleanupSection int // 0 = staging; 1..256 = objects/00..ff
}

func validFeedbackHex(s string) bool {
	if len(s) != 32 {
		return false
	}
	for _, c := range s {
		if !((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f')) {
			return false
		}
	}
	return true
}

func OpenFeedbackImageStore(dir string) (*FeedbackImageStore, error) {
	if strings.TrimSpace(dir) == "" {
		return nil, errors.New("FEEDBACK_IMAGE_DIR is empty")
	}
	if err := os.MkdirAll(dir, 0700); err != nil {
		return nil, errors.New("cannot create FEEDBACK_IMAGE_DIR")
	}
	root, err := os.OpenRoot(dir)
	if err != nil {
		return nil, errors.New("cannot open FEEDBACK_IMAGE_DIR")
	}
	fail := func() (*FeedbackImageStore, error) {
		root.Close()
		return nil, errors.New("FEEDBACK_IMAGE_DIR must be a writable dedicated feedback image store")
	}
	marker, err := root.Lstat(feedbackStoreMarkerName)
	if errors.Is(err, fs.ErrNotExist) {
		d, openErr := root.Open(".")
		if openErr != nil {
			return fail()
		}
		entries, readErr := d.ReadDir(1)
		d.Close()
		if len(entries) != 0 || (readErr != nil && readErr != io.EOF) {
			return fail()
		}
		f, createErr := root.OpenFile(feedbackStoreMarkerName, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
		if createErr != nil {
			return fail()
		}
		_, writeErr := io.WriteString(f, feedbackStoreMarker)
		syncErr := f.Sync()
		closeErr := f.Close()
		if writeErr != nil || syncErr != nil || closeErr != nil {
			return fail()
		}
	} else {
		if err != nil || !marker.Mode().IsRegular() {
			return fail()
		}
		f, openErr := root.Open(feedbackStoreMarkerName)
		if openErr != nil {
			return fail()
		}
		b, readErr := io.ReadAll(io.LimitReader(f, 128))
		f.Close()
		if readErr != nil || string(b) != feedbackStoreMarker {
			return fail()
		}
	}
	for _, sub := range []string{"staging", "objects"} {
		if err := root.MkdirAll(sub, 0700); err != nil {
			return fail()
		}
		info, err := root.Lstat(sub)
		if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
			return fail()
		}
	}
	probeID, err := randomHex32()
	if err != nil {
		return fail()
	}
	probe := path.Join("staging", probeID)
	f, err := root.OpenFile(probe, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return fail()
	}
	syncErr := f.Sync()
	closeErr := f.Close()
	removeErr := root.Remove(probe)
	if syncErr != nil || closeErr != nil || removeErr != nil {
		return fail()
	}
	s := &FeedbackImageStore{root: root, processing: make(chan struct{}, 1)}
	if err := s.syncDirectory("."); err != nil {
		return fail()
	}
	return s, nil
}

func (s *FeedbackImageStore) Close() error {
	if s == nil {
		return nil
	}
	s.guard.Lock()
	defer s.guard.Unlock()
	if s.cleanupDir != nil {
		_ = s.cleanupDir.Close()
		s.cleanupDir = nil
	}
	return s.root.Close()
}

type stagedFeedbackImage struct {
	row  model.FeedbackImage
	dir  string
	hash string
}

// An attempt owns only its staging directory. Close must never remove final
// objects: even a returned commit error may have committed their SQL references.
type FeedbackImageAttempt struct {
	store    *FeedbackImageStore
	dir      string
	images   []stagedFeedbackImage
	closed   bool
	prepared bool
}

func (s *FeedbackImageStore) Begin(ctx context.Context) (*FeedbackImageAttempt, error) {
	if s == nil {
		return nil, ErrFeedbackImageStore
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	s.guard.RLock()
	id, err := randomHex32()
	if err != nil {
		s.guard.RUnlock()
		return nil, ErrFeedbackImageStore
	}
	dir := path.Join("staging", id)
	if err := s.root.Mkdir(dir, 0700); err != nil {
		s.guard.RUnlock()
		return nil, ErrFeedbackImageStore
	}
	return &FeedbackImageAttempt{store: s, dir: dir}, nil
}

type feedbackContextReader struct {
	ctx context.Context
	r   io.Reader
}

func (r feedbackContextReader) Read(p []byte) (int, error) {
	if err := r.ctx.Err(); err != nil {
		return 0, err
	}
	return r.r.Read(p)
}

func (a *FeedbackImageAttempt) AddImage(ctx context.Context, input io.Reader) error {
	if a == nil || a.closed || a.prepared {
		return ErrFeedbackImageStore
	}
	if len(a.images) >= FeedbackMaxImages {
		return ErrFeedbackImageLimit
	}
	id, err := randomHex32()
	if err != nil {
		return ErrFeedbackImageStore
	}
	dir := path.Join(a.dir, id)
	if err := a.store.root.Mkdir(dir, 0700); err != nil {
		return ErrFeedbackImageStore
	}
	f, err := a.store.root.OpenFile(path.Join(dir, "input"), os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return ErrFeedbackImageStore
	}
	hash := sha256.New()
	n, copyErr := io.Copy(io.MultiWriter(f, hash), io.LimitReader(feedbackContextReader{ctx, input}, FeedbackMaxImageBytes+1))
	syncErr := f.Sync()
	closeErr := f.Close()
	if n > FeedbackMaxImageBytes {
		return ErrFeedbackImageLimit
	}
	if copyErr != nil {
		return copyErr
	}
	if syncErr != nil || closeErr != nil {
		return ErrFeedbackImageStore
	}
	if n == 0 {
		return ErrFeedbackImageFormat
	}
	a.images = append(a.images, stagedFeedbackImage{dir: dir, hash: hex.EncodeToString(hash.Sum(nil)), row: model.FeedbackImage{ID: id, Position: len(a.images), ByteSize: n}})
	return nil
}

func (a *FeedbackImageAttempt) Count() int {
	if a == nil {
		return 0
	}
	return len(a.images)
}
func (a *FeedbackImageAttempt) hashes() []string {
	out := make([]string, 0, a.Count())
	if a != nil {
		for _, img := range a.images {
			out = append(out, img.hash)
		}
	}
	return out
}

func (a *FeedbackImageAttempt) Prepare(ctx context.Context) ([]model.FeedbackImage, error) {
	if a == nil {
		return nil, nil
	}
	if a.closed || a.prepared {
		return nil, ErrFeedbackImageStore
	}
	select {
	case <-ctx.Done():
		return nil, ctx.Err()
	case a.store.processing <- struct{}{}:
	default:
		return nil, ErrFeedbackImageStore
	}
	defer func() { <-a.store.processing }()
	for i := range a.images {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		img := &a.images[i]
		if err := a.store.processImage(ctx, img); err != nil {
			return nil, err
		}
	}
	rows := make([]model.FeedbackImage, 0, len(a.images))
	for _, img := range a.images {
		prefix := path.Join("objects", img.row.ID[:2])
		if err := a.store.root.MkdirAll(prefix, 0700); err != nil {
			return nil, ErrFeedbackImageStore
		}
		if err := a.store.noSymlinkDirectory(prefix); err != nil {
			return nil, ErrFeedbackImageStore
		}
		if err := a.store.root.Rename(img.dir, path.Join(prefix, img.row.ID)); err != nil {
			return nil, ErrFeedbackImageStore
		}
		if err := a.store.syncDirectory(prefix); err != nil {
			return nil, ErrFeedbackImageStore
		}
		rows = append(rows, img.row)
	}
	if err := a.store.syncDirectory("objects"); err != nil {
		return nil, ErrFeedbackImageStore
	}
	a.prepared = true
	return rows, nil
}

func (a *FeedbackImageAttempt) Close() {
	if a == nil || a.closed {
		return
	}
	a.closed = true
	// All components are generated; Root confines the removal even after a
	// symlink substitution. Final objects are outside this path by construction.
	_ = a.store.root.RemoveAll(a.dir)
	a.store.guard.RUnlock()
}

func feedbackImageExtension(mime string) (string, bool) {
	switch mime {
	case "image/jpeg":
		return "jpg", true
	case "image/png":
		return "png", true
	case "image/webp":
		return "webp", true
	}
	return "", false
}

func (s *FeedbackImageStore) noSymlinkDirectory(dir string) error {
	current := ""
	for _, part := range strings.Split(dir, "/") {
		current = path.Join(current, part)
		info, err := s.root.Lstat(current)
		if err != nil {
			return err
		}
		if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
			return ErrFeedbackImageStore
		}
	}
	return nil
}

func (s *FeedbackImageStore) syncDirectory(dir string) error {
	// Windows FlushFileBuffers does not support directory handles. Linux (the
	// deployed runtime) syncs directory entries as well as each file's content.
	if runtime.GOOS == "windows" {
		return nil
	}
	f, err := s.root.Open(dir)
	if err != nil {
		return err
	}
	defer f.Close()
	return f.Sync()
}

func (s *FeedbackImageStore) OpenImage(row model.FeedbackImage, variant string) (*os.File, string, int64, error) {
	if s == nil || !validFeedbackHex(row.ID) {
		return nil, "", 0, ErrFeedbackImageStore
	}
	mime, size := row.MIMEType, row.ByteSize
	if variant == "thumbnail" {
		mime, size = row.ThumbnailMIMEType, row.ThumbnailByteSize
	} else if variant != "original" {
		return nil, "", 0, ErrFeedbackNotFound
	}
	ext, ok := feedbackImageExtension(mime)
	if !ok || size <= 0 {
		return nil, "", 0, ErrFeedbackImageStore
	}
	dir := path.Join("objects", row.ID[:2], row.ID)
	if err := s.noSymlinkDirectory(dir); err != nil {
		return nil, "", 0, ErrFeedbackImageStore
	}
	name := path.Join(dir, variant+"."+ext)
	info, err := s.root.Lstat(name)
	if err != nil || !info.Mode().IsRegular() || info.Size() != size {
		return nil, "", 0, ErrFeedbackImageStore
	}
	f, err := s.root.Open(name)
	if err != nil {
		return nil, "", 0, ErrFeedbackImageStore
	}
	return f, mime, size, nil
}

// Cleanup scans at most limit entries (fresh, referenced and unknown entries
// count too) and advances a retained directory cursor. At most 257 section
// boundaries are checked per pass. An SQL failure is never evidence of absence.
func (s *FeedbackImageStore) Cleanup(ctx context.Context, db *gorm.DB, now time.Time, limit int) (int, error) {
	if limit < 1 || limit > 100 {
		limit = 100
	}
	s.guard.Lock()
	defer s.guard.Unlock()
	cutoff := now.Add(-feedbackOrphanGrace)
	removed, scanned, boundaries := 0, 0, 0
	nextSection := func() {
		if s.cleanupDir != nil {
			_ = s.cleanupDir.Close()
			s.cleanupDir = nil
		}
		s.cleanupSection = (s.cleanupSection + 1) % 257
		boundaries++
	}
	for scanned < limit && boundaries < 257 {
		if err := ctx.Err(); err != nil {
			return removed, err
		}
		staging := s.cleanupSection == 0
		base := "staging"
		if !staging {
			base = fmt.Sprintf("objects/%02x", s.cleanupSection-1)
		}
		if s.cleanupDir == nil {
			if err := s.noSymlinkDirectory(base); err != nil {
				if errors.Is(err, fs.ErrNotExist) {
					nextSection()
					continue
				}
				nextSection()
				return removed, err
			}
			dir, err := s.root.Open(base)
			if err != nil {
				nextSection()
				return removed, err
			}
			s.cleanupDir = dir
		}
		entries, err := s.cleanupDir.ReadDir(1)
		if err == io.EOF {
			nextSection()
			continue
		}
		if err != nil {
			nextSection()
			return removed, err
		}
		scanned++
		entry := entries[0]
		if !validFeedbackHex(entry.Name()) || !entry.IsDir() || entry.Type()&os.ModeSymlink != 0 {
			continue
		}
		info, err := entry.Info()
		if err != nil || !info.ModTime().Before(cutoff) {
			continue
		}
		rel := path.Join(base, entry.Name())
		ids := []string{entry.Name()}
		if staging {
			ids, err = s.stagingObjectIDs(rel)
			if err != nil {
				continue
			}
		} else if !strings.HasSuffix(base, "/"+entry.Name()[:2]) || !s.recognizedObject(rel, false) {
			continue
		}
		var refs int64
		// Even an empty staging directory requires a successful DB check.
		if err := db.WithContext(ctx).Model(&model.FeedbackImage{}).Where("id IN ?", ids).Count(&refs).Error; err != nil {
			return removed, err
		}
		if refs != 0 {
			continue
		}
		if err := s.root.RemoveAll(rel); err != nil {
			return removed, err
		}
		removed++
	}
	return removed, nil
}

func (s *FeedbackImageStore) stagingObjectIDs(dir string) ([]string, error) {
	f, err := s.root.Open(dir)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	entries, err := f.ReadDir(FeedbackMaxImages + 1)
	if err != nil && err != io.EOF {
		return nil, err
	}
	if len(entries) > FeedbackMaxImages {
		return nil, ErrFeedbackImageStore
	}
	ids := make([]string, 0, len(entries))
	for _, entry := range entries {
		if !validFeedbackHex(entry.Name()) || !entry.IsDir() || entry.Type()&os.ModeSymlink != 0 || !s.recognizedObject(path.Join(dir, entry.Name()), true) {
			return nil, ErrFeedbackImageStore
		}
		ids = append(ids, entry.Name())
	}
	return ids, nil
}

func (s *FeedbackImageStore) recognizedObject(dir string, staging bool) bool {
	f, err := s.root.Open(dir)
	if err != nil {
		return false
	}
	defer f.Close()
	entries, err := f.ReadDir(4)
	if (err != nil && err != io.EOF) || len(entries) > 3 {
		return false
	}
	for _, entry := range entries {
		info, err := entry.Info()
		if err != nil || !info.Mode().IsRegular() {
			return false
		}
		switch entry.Name() {
		case "original.jpg", "original.png", "original.webp", "thumbnail.jpg", "thumbnail.png":
		case "input":
			if !staging {
				return false
			}
		default:
			return false
		}
	}
	return true
}

func (s *FeedbackImageStore) RunCleanup(ctx context.Context, db *gorm.DB) {
	clean := func() {
		cleanupCtx, cancel := context.WithTimeout(ctx, time.Minute)
		defer cancel()
		// Errors retain objects; maintenance must not endanger publication.
		_, _ = s.Cleanup(cleanupCtx, db, time.Now(), 100)
	}
	clean()
	ticker := time.NewTicker(time.Hour)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			clean()
		}
	}
}
