package service

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"fmt"
	"hash/crc32"
	"image"
	"image/color"
	"image/jpeg"
	"image/png"
	"io"
	"os"
	"path"
	"path/filepath"
	"testing"
	"time"

	"welfare/model"
)

func feedbackTestPNG(t *testing.T) []byte {
	t.Helper()
	img := image.NewNRGBA(image.Rect(0, 0, 8, 6))
	img.SetNRGBA(0, 0, color.NRGBA{R: 200, G: 100, A: 100})
	var b bytes.Buffer
	if err := png.Encode(&b, img); err != nil {
		t.Fatal(err)
	}
	return b.Bytes()
}

func feedbackTestStore(t *testing.T) *FeedbackImageStore {
	t.Helper()
	store, err := OpenFeedbackImageStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { store.Close() })
	return store
}

func feedbackTestAttempt(t *testing.T, store *FeedbackImageStore, raw ...[]byte) *FeedbackImageAttempt {
	t.Helper()
	a, err := store.Begin(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(a.Close)
	for _, img := range raw {
		if err := a.AddImage(context.Background(), bytes.NewReader(img)); err != nil {
			t.Fatal(err)
		}
	}
	return a
}

func feedbackEXIF(orientation uint16) []byte {
	b := []byte{'I', 'I', 42, 0, 8, 0, 0, 0, 1, 0, 0x12, 1, 3, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0}
	binary.LittleEndian.PutUint16(b[18:20], orientation)
	return b
}

func feedbackPNGChunk(kind string, data []byte) []byte {
	b := make([]byte, 12+len(data))
	binary.BigEndian.PutUint32(b[:4], uint32(len(data)))
	copy(b[4:8], kind)
	copy(b[8:], data)
	binary.BigEndian.PutUint32(b[len(b)-4:], crc32.ChecksumIEEE(b[4:len(b)-4]))
	return b
}

func TestFeedbackImageFormatsOriginalAndOrientation(t *testing.T) {
	store := feedbackTestStore(t)
	jpegImage := image.NewNRGBA(image.Rect(0, 0, 80, 40))
	for y := 0; y < 40; y++ {
		for x := 0; x < 80; x++ {
			c := color.NRGBA{R: 240, A: 255}
			if x >= 40 {
				c = color.NRGBA{B: 240, A: 255}
			}
			jpegImage.SetNRGBA(x, y, c)
		}
	}
	var encoded bytes.Buffer
	if err := jpeg.Encode(&encoded, jpegImage, &jpeg.Options{Quality: 100}); err != nil {
		t.Fatal(err)
	}
	exif := append([]byte("Exif\x00\x00"), feedbackEXIF(6)...)
	segment := []byte{0xff, 0xe1, 0, 0}
	binary.BigEndian.PutUint16(segment[2:], uint16(len(exif)+2))
	orientedJPEG := append(append(append([]byte{}, encoded.Bytes()[:2]...), append(segment, exif...)...), encoded.Bytes()[2:]...)
	transparent := feedbackTestPNG(t)
	orientedPNG := append(append(append([]byte{}, transparent[:33]...), feedbackPNGChunk("eXIf", feedbackEXIF(6))...), transparent[33:]...)
	webp, err := base64.StdEncoding.DecodeString("UklGRh4AAABXRUJQVlA4TBEAAAAvAYAAEAdQyyqUolCBiOh/AAA=")
	if err != nil {
		t.Fatal(err)
	}
	for _, test := range []struct {
		name          string
		data          []byte
		width, height int
		mime, thumb   string
	}{
		{"png", transparent, 8, 6, "image/png", "image/png"}, {"jpeg-orientation-6", orientedJPEG, 40, 80, "image/jpeg", "image/jpeg"},
		{"png-orientation-6", orientedPNG, 6, 8, "image/png", "image/png"}, {"webp-alpha", webp, 2, 3, "image/webp", "image/png"},
	} {
		t.Run(test.name, func(t *testing.T) {
			a := feedbackTestAttempt(t, store, test.data)
			rows, err := a.Prepare(context.Background())
			if err != nil {
				t.Fatal(err)
			}
			row := rows[0]
			if row.Width != test.width || row.Height != test.height || row.MIMEType != test.mime || row.ThumbnailMIMEType != test.thumb {
				t.Fatalf("metadata: %+v", row)
			}
			f, _, _, err := store.OpenImage(row, "original")
			if err != nil {
				t.Fatal(err)
			}
			original, err := io.ReadAll(f)
			f.Close()
			if err != nil || !bytes.Equal(original, test.data) {
				t.Fatal("original bytes changed")
			}
			f, _, _, err = store.OpenImage(row, "thumbnail")
			if err != nil {
				t.Fatal(err)
			}
			thumb, _, err := image.Decode(f)
			f.Close()
			if err != nil {
				t.Fatal(err)
			}
			if thumb.Bounds().Dx() > 512 || thumb.Bounds().Dy() > 512 || thumb.Bounds().Dx() != test.width || thumb.Bounds().Dy() != test.height || row.ThumbnailByteSize > feedbackThumbnailMaxBytes {
				t.Fatalf("thumbnail bounds: %v", thumb.Bounds())
			}
			if test.name == "jpeg-orientation-6" {
				r, _, b, _ := thumb.At(20, 10).RGBA()
				if r <= b {
					t.Fatal("rotated JPEG top must be red")
				}
				r, _, b, _ = thumb.At(20, 70).RGBA()
				if b <= r {
					t.Fatal("rotated JPEG bottom must be blue")
				}
			}
			a.Close()
		})
	}
}

func TestFeedbackImageRejectionAndLimits(t *testing.T) {
	store := feedbackTestStore(t)
	pngData := feedbackTestPNG(t)
	animated := append(append(append([]byte{}, pngData[:33]...), feedbackPNGChunk("acTL", []byte{0, 0, 0, 2, 0, 0, 0, 0})...), pngData[33:]...)
	tooWide := append([]byte{}, pngData...)
	binary.BigEndian.PutUint32(tooWide[16:20], 8193)
	binary.BigEndian.PutUint32(tooWide[29:33], crc32.ChecksumIEEE(tooWide[12:29]))
	tooManyPixels := append([]byte{}, pngData...)
	binary.BigEndian.PutUint32(tooManyPixels[16:20], 5000)
	binary.BigEndian.PutUint32(tooManyPixels[20:24], 5000)
	binary.BigEndian.PutUint32(tooManyPixels[29:33], crc32.ChecksumIEEE(tooManyPixels[12:29]))
	for _, test := range []struct {
		name string
		data []byte
		want error
	}{
		{"gif", []byte("GIF89a"), ErrFeedbackImageFormat}, {"svg", []byte("<svg/>"), ErrFeedbackImageFormat}, {"corrupt", pngData[:len(pngData)-8], ErrFeedbackImageFormat},
		{"apng", animated, ErrFeedbackImageFormat}, {"width", tooWide, ErrFeedbackImageLimit}, {"pixels", tooManyPixels, ErrFeedbackImageLimit},
	} {
		t.Run(test.name, func(t *testing.T) {
			a := feedbackTestAttempt(t, store, test.data)
			if _, err := a.Prepare(context.Background()); !errors.Is(err, test.want) {
				t.Fatalf("got %v want %v", err, test.want)
			}
			a.Close()
		})
	}
	a := feedbackTestAttempt(t, store, pngData, pngData, pngData)
	if err := a.AddImage(context.Background(), bytes.NewReader(pngData)); !errors.Is(err, ErrFeedbackImageLimit) {
		t.Fatal(err)
	}
	a.Close()
	a = feedbackTestAttempt(t, store)
	if err := a.AddImage(context.Background(), bytes.NewReader(make([]byte, FeedbackMaxImageBytes+1))); !errors.Is(err, ErrFeedbackImageLimit) {
		t.Fatal(err)
	}
	a.Close()
	store.processing <- struct{}{}
	a = feedbackTestAttempt(t, store, pngData)
	if _, err := a.Prepare(context.Background()); !errors.Is(err, ErrFeedbackImageStore) {
		t.Fatal("busy slot must reject instead of queueing unbounded decodes")
	}
	<-store.processing
	a.Close()
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := store.Begin(ctx); !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
}

func TestFeedbackImageStoreConfinementAndRestart(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "unrelated.txt"), []byte("keep"), 0600); err != nil {
		t.Fatal(err)
	}
	if store, err := OpenFeedbackImageStore(dir); err == nil {
		store.Close()
		t.Fatal("adopted unrelated directory")
	}
	dir = t.TempDir()
	store, err := OpenFeedbackImageStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	a := feedbackTestAttempt(t, store, feedbackTestPNG(t))
	rows, err := a.Prepare(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	a.Close()
	store.Close()
	store, err = OpenFeedbackImageStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	f, _, _, err := store.OpenImage(rows[0], "original")
	if err != nil {
		t.Fatal("reopened store lost original:", err)
	}
	f.Close()
	bad := rows[0]
	bad.ID = "../../../../outside"
	if _, _, _, err := store.OpenImage(bad, "original"); err == nil {
		t.Fatal("accepted path traversal ID")
	}
	// In-process files and an os.Root prevent even intra-store symlink reuse of
	// another image. Windows without symlink privilege still checks traversal.
	name := filepath.Join(dir, "objects", rows[0].ID[:2], rows[0].ID, "original.png")
	other := filepath.Join(t.TempDir(), "private.png")
	if err := os.WriteFile(other, feedbackTestPNG(t), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(name); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(other, name); err == nil {
		if _, _, _, err := store.OpenImage(rows[0], "original"); err == nil {
			t.Fatal("followed an image symlink")
		}
	}
}

func TestFeedbackImageCleanupPreservesReferencesAndDatabaseFailures(t *testing.T) {
	db := grantDB(t)
	store := feedbackTestStore(t)
	old := time.Now().Add(-48 * time.Hour)
	var rows []model.FeedbackImage
	for i := 0; i < 2; i++ {
		a := feedbackTestAttempt(t, store, feedbackTestPNG(t))
		created, err := a.Prepare(context.Background())
		if err != nil {
			t.Fatal(err)
		}
		rows = append(rows, created[0])
		a.Close()
	}
	rows[0].FeedbackID = 17
	if err := db.Create(&rows[0]).Error; err != nil {
		t.Fatal(err)
	}
	for _, row := range rows {
		if err := store.root.Chtimes(path.Join("objects", row.ID[:2], row.ID), old, old); err != nil {
			t.Fatal(err)
		}
	}
	if n, err := store.Cleanup(context.Background(), db, time.Now(), 100); err != nil || n != 1 {
		t.Fatalf("cleanup n=%d err=%v", n, err)
	}
	f, _, _, err := store.OpenImage(rows[0], "original")
	if err != nil {
		t.Fatal("deleted referenced (including hidden) content")
	}
	f.Close()
	a := feedbackTestAttempt(t, store, feedbackTestPNG(t))
	newRows, err := a.Prepare(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	a.Close()
	if err := store.root.Chtimes(path.Join("objects", newRows[0].ID[:2], newRows[0].ID), old, old); err != nil {
		t.Fatal(err)
	}
	if err := db.Migrator().DropTable(&model.FeedbackImage{}); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Cleanup(context.Background(), db, time.Now(), 100); err == nil {
		t.Fatal("database failure must skip deletion")
	}
	f, _, _, err = store.OpenImage(newRows[0], "original")
	if err != nil {
		t.Fatal("DB error treated as unreferenced")
	}
	f.Close()
}

func TestFeedbackImageCleanupWaitsForActivePublication(t *testing.T) {
	db := grantDB(t)
	store := feedbackTestStore(t)
	a := feedbackTestAttempt(t, store, feedbackTestPNG(t))
	rows, err := a.Prepare(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	old := time.Now().Add(-48 * time.Hour)
	if err := store.root.Chtimes(path.Join("objects", rows[0].ID[:2], rows[0].ID), old, old); err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() { _, err := store.Cleanup(context.Background(), db, time.Now(), 100); done <- err }()
	select {
	case err := <-done:
		t.Fatalf("cleanup crossed active attempt: %v", err)
	case <-time.After(20 * time.Millisecond):
	}
	rows[0].FeedbackID = 88
	if err := db.Create(&rows[0]).Error; err != nil {
		t.Fatal(err)
	}
	a.Close()
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	f, _, _, err := store.OpenImage(rows[0], "original")
	if err != nil {
		t.Fatal(err)
	}
	f.Close()
}

func TestFeedbackImageCleanupMakesBoundedProgressPastRetainedObjects(t *testing.T) {
	db := grantDB(t)
	store := feedbackTestStore(t)
	old := time.Now().Add(-48 * time.Hour)
	const retained = 105
	var kept []string
	orphan := ""
	for i := 0; i <= retained; i++ {
		id := fmt.Sprintf("%032x", i+1)
		dir := path.Join("objects", id[:2], id)
		if err := store.root.MkdirAll(dir, 0700); err != nil {
			t.Fatal(err)
		}
		file, err := store.root.OpenFile(path.Join(dir, "original.png"), os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
		if err != nil {
			t.Fatal(err)
		}
		_, err = file.Write(feedbackTestPNG(t))
		file.Close()
		if err != nil {
			t.Fatal(err)
		}
		if err := store.root.Chtimes(dir, old, old); err != nil {
			t.Fatal(err)
		}
		if i < retained {
			row := model.FeedbackImage{ID: id, FeedbackID: 1, MIMEType: "image/png", Width: 8, Height: 6, ByteSize: 1, ThumbnailMIMEType: "image/png", ThumbnailByteSize: 1}
			if err := db.Create(&row).Error; err != nil {
				t.Fatal(err)
			}
			kept = append(kept, dir)
		} else {
			orphan = dir
		}
	}
	removed := 0
	for pass := 0; pass < 20 && removed == 0; pass++ {
		n, err := store.Cleanup(context.Background(), db, time.Now(), 10)
		if err != nil {
			t.Fatal(err)
		}
		removed += n
	}
	if removed != 1 {
		t.Fatal("bounded cleanup repeatedly revisited retained objects and starved later orphan")
	}
	if _, err := store.root.Lstat(orphan); !os.IsNotExist(err) {
		t.Fatal("orphan still exists")
	}
	for _, dir := range kept {
		if _, err := store.root.Lstat(path.Join(dir, "original.png")); err != nil {
			t.Fatal("cleanup deleted referenced file")
		}
	}
}
