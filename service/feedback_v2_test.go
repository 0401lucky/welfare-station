package service

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"sync"
	"sync/atomic"
	"testing"

	"welfare/internal/feedbacktest"
	"welfare/model"

	"gorm.io/gorm"
)

func feedbackAttemptID(t *testing.T) string {
	t.Helper()
	id, err := randomHex32()
	if err != nil {
		t.Fatal(err)
	}
	return id
}

func verifyFeedbackV2Discussion(t *testing.T, db *gorm.DB) {
	t.Helper()
	if err := model.Migrate(db); err != nil {
		t.Fatal(err)
	}
	author := feedbackUser(t, db, "root-author", false)
	member := feedbackUser(t, db, "member", false)
	other := feedbackUser(t, db, "other", false)
	admin := feedbackUser(t, db, "owner", true)
	root, err := CreateFeedbackV2(db, &author, CreateFeedbackV2Input{ClientSubmissionID: feedbackAttemptID(t), Category: "issue", Content: "root"}, nil)
	if err != nil {
		t.Fatal(err)
	}
	first, err := AppendFeedbackReplyV2(db, root.ID, &member, ReplyFeedbackV2Input{ClientSubmissionID: feedbackAttemptID(t), Content: "participant secret"}, nil, false, "")
	if err != nil {
		t.Fatal(err)
	}
	ownerInput := ReplyFeedbackV2Input{ClientSubmissionID: feedbackAttemptID(t), Content: "owner text", ReplyToID: &first.ID}
	owner, err := AppendFeedbackReplyV2(db, root.ID, &admin, ownerInput, nil, true, "127.0.0.1")
	if err != nil {
		t.Fatal(err)
	}
	replay, err := AppendFeedbackReplyV2(db, root.ID, &admin, ownerInput, nil, true, "127.0.0.1")
	if err != nil || replay.ID != owner.ID {
		t.Fatalf("owner replay: %+v %v", replay, err)
	}
	if first.AuthorRole != FeedbackRoleMember || owner.AuthorRole != FeedbackRoleOwner || owner.ReplyTo == nil || owner.ReplyTo.ID != first.ID {
		t.Fatal("role/target projection")
	}
	legacy, err := GetFeedbackDetail(db, root.ID, nil, 1, 20)
	if err != nil || legacy.Message.ReplyCount != 1 || len(legacy.Replies.Items) != 1 || legacy.Replies.Items[0].ID != owner.ID {
		t.Fatalf("V1 includes member: %+v %v", legacy, err)
	}
	for i := 0; i < 5; i++ {
		if _, err := AppendFeedbackReplyV2(db, root.ID, &member, ReplyFeedbackV2Input{ClientSubmissionID: feedbackAttemptID(t), Content: fmt.Sprintf("reply %d", i)}, nil, false, ""); err != nil {
			t.Fatal(err)
		}
	}
	detail, err := GetFeedbackDetailV2(db, root.ID, nil, 1, 2, owner.ID)
	if err != nil || detail.Replies.Page != 1 || detail.Replies.Total != 7 || detail.CanReply {
		t.Fatalf("anchor/detail: %+v %v", detail, err)
	}
	last := detail.Replies.Items[1]
	if last.ID != owner.ID {
		t.Fatal("chronological ordering changed")
	}
	part, err := ListFeedbackV2(db, &member, "participated", FeedbackFilters{})
	if err != nil || part.Total != 1 || len(part.Items) != 1 || part.Items[0].ReplyCount != 7 {
		t.Fatalf("participation duplicates: %+v %v", part, err)
	}
	if _, err := ModerateFeedbackReplyV2(db, root.ID, first.ID, &admin, true, ""); err != nil {
		t.Fatal(err)
	}
	if _, err := ModerateFeedbackReplyV2(db, root.ID, first.ID, &admin, true, ""); err != nil {
		t.Fatal(err)
	}
	for _, viewer := range []*model.User{nil, &author, &other, &member, &admin} {
		detail, err := GetFeedbackDetailV2(db, root.ID, viewer, 1, 100, 0)
		if err != nil {
			t.Fatal(err)
		}
		allowed := viewer != nil && (viewer.ID == member.ID || viewer.IsAdmin)
		want := int64(6)
		if allowed {
			want = 7
		}
		if detail.Replies.Total != want || detail.Message.ReplyCount != want {
			t.Fatal("reply counts bypass visibility")
		}
		for _, reply := range detail.Replies.Items {
			if reply.ID == owner.ID {
				if allowed {
					if reply.ReplyTo == nil || reply.ReplyToUnavailable {
						t.Fatal("authorized target lost")
					}
				} else if reply.ReplyTo != nil || !reply.ReplyToUnavailable {
					t.Fatal("hidden target metadata leaked")
				}
			}
		}
	}
	if _, err := GetFeedbackDetailV2(db, root.ID, &other, 1, 2, first.ID); !errors.Is(err, ErrFeedbackNotFound) {
		t.Fatal("hidden anchor accepted:", err)
	}
	if _, err := AppendFeedbackReplyV2(db, root.ID, &other, ReplyFeedbackV2Input{ClientSubmissionID: feedbackAttemptID(t), Content: "hidden target", ReplyToID: &first.ID}, nil, false, ""); !errors.Is(err, ErrFeedbackNotFound) {
		t.Fatal(err)
	}
	private, err := CreateFeedbackV2(db, &author, CreateFeedbackV2Input{ClientSubmissionID: feedbackAttemptID(t), Category: "message", Content: "private", IsPrivate: true}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := AppendFeedbackReplyV2(db, private.ID, &member, ReplyFeedbackV2Input{ClientSubmissionID: feedbackAttemptID(t), Content: "no access"}, nil, false, ""); !errors.Is(err, ErrFeedbackNotFound) {
		t.Fatal(err)
	}
	if _, err := UpdateFeedbackModeration(db, root.ID, &admin, true); err != nil {
		t.Fatal(err)
	}
	part, err = ListFeedbackV2(db, &member, "participated", FeedbackFilters{})
	if err != nil || part.Total != 0 {
		t.Fatal("participation bypassed parent hiding")
	}
	if _, err := GetFeedbackDetailV2(db, root.ID, &member, 1, 20, 0); !errors.Is(err, ErrFeedbackNotFound) {
		t.Fatal("reply author bypassed hidden parent")
	}
	wall, err := ListFeedbackV2(db, &admin, "public", FeedbackFilters{})
	if err != nil || wall.Total != 0 {
		t.Fatal("admin/public list broadened audience")
	}
	if _, err := UpdateFeedbackModeration(db, root.ID, &admin, false); err != nil {
		t.Fatal(err)
	}
	if _, err := ModerateFeedbackReplyV2(db, root.ID, first.ID, &admin, false, ""); err != nil {
		t.Fatal(err)
	}
	var audits []model.AdminLog
	if err := db.Find(&audits).Error; err != nil {
		t.Fatal(err)
	}
	if len(audits) != 3 {
		t.Fatalf("exactly-once owner/moderation audits: %+v", audits)
	}
	for _, audit := range audits {
		if strings.Contains(audit.Detail, "owner text") || strings.Contains(audit.Detail, "participant secret") {
			t.Fatal("audit includes private body")
		}
	}
	if err := db.Model(&model.User{}).Where("id = ?", admin.ID).Update("is_admin", false).Error; err != nil {
		t.Fatal(err)
	}
	if _, err := AppendFeedbackReplyV2(db, root.ID, &admin, ownerInput, nil, true, ""); !errors.Is(err, ErrFeedbackAdminRequired) {
		t.Fatal("revoked owner replay succeeded:", err)
	}
	if err := db.Model(&model.User{}).Where("id = ?", member.ID).Update("status", 2).Error; err != nil {
		t.Fatal(err)
	}
	if _, err := AppendFeedbackReplyV2(db, root.ID, &member, ReplyFeedbackV2Input{ClientSubmissionID: feedbackAttemptID(t), Content: "stale identity"}, nil, false, ""); !errors.Is(err, ErrFeedbackLoginRequired) {
		t.Fatal("disabled writer succeeded:", err)
	}
}

func TestFeedbackV2DiscussionSQLite(t *testing.T) { verifyFeedbackV2Discussion(t, grantDB(t)) }
func TestFeedbackV2DiscussionMySQL(t *testing.T) {
	verifyFeedbackV2Discussion(t, feedbacktest.MySQL(t))
}

func verifyFeedbackV2ConcurrentRetry(t *testing.T, db *gorm.DB) {
	t.Helper()
	if err := model.Migrate(db); err != nil {
		t.Fatal(err)
	}
	user := feedbackUser(t, db, "concurrent", true)
	input := CreateFeedbackV2Input{ClientSubmissionID: feedbackAttemptID(t), Category: "message", Content: "same attempt"}
	var wg sync.WaitGroup
	ids := make(chan int64, 8)
	errs := make(chan error, 8)
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			item, err := CreateFeedbackV2(db, &user, input, nil)
			if err != nil {
				errs <- err
			} else {
				ids <- item.ID
			}
		}()
	}
	wg.Wait()
	close(ids)
	close(errs)
	for err := range errs {
		t.Error(err)
	}
	var first int64
	for id := range ids {
		if first == 0 {
			first = id
		}
		if id != first {
			t.Fatal("concurrent attempts published duplicate roots")
		}
	}
	input.Content = "changed"
	if _, err := CreateFeedbackV2(db, &user, input, nil); !errors.Is(err, ErrFeedbackSubmissionConflict) {
		t.Fatal("changed root accepted:", err)
	}
	replyInput := ReplyFeedbackV2Input{ClientSubmissionID: feedbackAttemptID(t), Content: "owner concurrent"}
	ids = make(chan int64, 8)
	errs = make(chan error, 8)
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			reply, err := AppendFeedbackReplyV2(db, first, &user, replyInput, nil, true, "127.0.0.1")
			if err != nil {
				errs <- err
			} else {
				ids <- reply.ID
			}
		}()
	}
	wg.Wait()
	close(ids)
	close(errs)
	for err := range errs {
		t.Error(err)
	}
	var firstReply int64
	for id := range ids {
		if firstReply == 0 {
			firstReply = id
		}
		if id != firstReply {
			t.Fatal("concurrent attempts duplicated reply")
		}
	}
	var count int64
	db.Model(&model.AdminLog{}).Count(&count)
	if count != 1 {
		t.Fatalf("retry duplicated owner audit: %d", count)
	}
}
func TestFeedbackV2ConcurrentRetrySQLite(t *testing.T) {
	verifyFeedbackV2ConcurrentRetry(t, grantDB(t))
}
func TestFeedbackV2ConcurrentRetryMySQL(t *testing.T) {
	verifyFeedbackV2ConcurrentRetry(t, feedbacktest.MySQL(t))
}

func TestFeedbackV2ImagePublicationReplayAndRollback(t *testing.T) {
	db := grantDB(t)
	store := feedbackTestStore(t)
	user := feedbackUser(t, db, "image-author", true)
	input := CreateFeedbackV2Input{ClientSubmissionID: feedbackAttemptID(t), Category: "message"}
	firstAttempt := feedbackTestAttempt(t, store, feedbackTestPNG(t))
	item, err := CreateFeedbackV2(db, &user, input, firstAttempt)
	if err != nil {
		t.Fatal(err)
	}
	firstAttempt.Close()
	if item.Content != "" || len(item.Images) != 1 {
		t.Fatal("image-only create")
	}
	repeat := feedbackTestAttempt(t, store, feedbackTestPNG(t))
	again, err := CreateFeedbackV2(db, &user, input, repeat)
	repeat.Close()
	if err != nil || again.ID != item.ID || again.Images[0].ID != item.Images[0].ID {
		t.Fatalf("image replay duplicated: %+v %v", again, err)
	}
	legacy, err := GetFeedbackDetail(db, item.ID, nil, 1, 20)
	if err != nil || legacy.Message.Content == "" || !strings.Contains(legacy.Message.Content, "刷新") {
		t.Fatal("V1 shows blank image-only body")
	}
	if err := db.Callback().Create().Before("gorm:create").Register("fail-v2-audit", func(tx *gorm.DB) {
		if tx.Statement.Table == "w_admin_logs" {
			tx.AddError(errors.New("injected audit failure"))
		}
	}); err != nil {
		t.Fatal(err)
	}
	failAttempt := feedbackTestAttempt(t, store, feedbackTestPNG(t))
	if _, err := AppendFeedbackReplyV2(db, item.ID, &user, ReplyFeedbackV2Input{ClientSubmissionID: feedbackAttemptID(t)}, failAttempt, true, ""); err == nil {
		t.Fatal("audit failure must rollback local publication")
	}
	failAttempt.Close()
	db.Callback().Create().Remove("fail-v2-audit")
	var count int64
	db.Model(&model.FeedbackReply{}).Count(&count)
	if count != 0 {
		t.Fatal("failed audit published a reply")
	}
	db.Model(&model.FeedbackImage{}).Count(&count)
	if count != 1 {
		t.Fatal("failed reply left a published image record")
	}
	final := failAttempt.images[0].row
	f, _, _, err := store.OpenImage(final, "original")
	if err != nil {
		t.Fatal("failed commit path deleted potentially published files")
	}
	f.Close()
}

type feedbackUncertainPool struct {
	gorm.ConnPool
	fired  atomic.Bool
	cancel context.CancelFunc
}

func (p *feedbackUncertainPool) BeginTx(ctx context.Context, opts *sql.TxOptions) (gorm.ConnPool, error) {
	tx, err := p.ConnPool.(gorm.TxBeginner).BeginTx(ctx, opts)
	if err != nil {
		return nil, err
	}
	return &feedbackUncertainTx{Tx: tx, pool: p}, nil
}

type feedbackUncertainTx struct {
	*sql.Tx
	pool *feedbackUncertainPool
}

func (tx *feedbackUncertainTx) Commit() error {
	if err := tx.Tx.Commit(); err != nil {
		return err
	}
	if tx.pool.fired.CompareAndSwap(false, true) {
		if tx.pool.cancel != nil {
			tx.pool.cancel()
		}
		return errors.New("injected lost commit acknowledgement")
	}
	return nil
}

func TestFeedbackV2UncertainCommitAndCancelledResponse(t *testing.T) {
	db := grantDB(t)
	store := feedbackTestStore(t)
	user := feedbackUser(t, db, "uncertain", true)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	faultDB := db.Session(&gorm.Session{NewDB: true, Context: ctx})
	faultDB.Statement.ConnPool = &feedbackUncertainPool{ConnPool: db.Statement.ConnPool, cancel: cancel}
	input := CreateFeedbackV2Input{ClientSubmissionID: feedbackAttemptID(t), Category: "message"}
	a := feedbackTestAttempt(t, store, feedbackTestPNG(t))
	item, err := CreateFeedbackV2(faultDB, &user, input, a)
	a.Close()
	if err != nil || item == nil {
		t.Fatalf("committed row must reconcile after cancelled/lost ack: %+v %v", item, err)
	}
	retry := feedbackTestAttempt(t, store, feedbackTestPNG(t))
	again, err := CreateFeedbackV2(db, &user, input, retry)
	retry.Close()
	if err != nil || again.ID != item.ID || again.Images[0].ID != item.Images[0].ID {
		t.Fatal("uncertain retry duplicated image publication")
	}
	row, err := AuthorizeFeedbackImage(db, item.Images[0].ID, nil)
	if err != nil {
		t.Fatal(err)
	}
	f, _, _, err := store.OpenImage(*row, "original")
	if err != nil {
		t.Fatal("lost ack removed published image")
	}
	f.Close()
}

func TestFeedbackV2LiveAuthorityAfterImageProcessing(t *testing.T) {
	db := grantDB(t)
	store := feedbackTestStore(t)
	user := feedbackUser(t, db, "revoked-upload", true)
	root := createFeedback(t, db, &user, "message", "root", false)
	// Mutation before the write transaction starts simulates authority changing
	// while the original bytes/thumbnail were being processed.
	if err := db.Callback().Query().After("gorm:query").Register("revoke-upload", func(tx *gorm.DB) {
		if tx.Statement.Table == "w_feedback_replies" && tx.Statement.SQL.String() != "" {
			_ = db.Session(&gorm.Session{SkipHooks: true}).Model(&model.User{}).Where("id = ?", user.ID).Update("is_admin", false).Error
		}
	}); err != nil {
		t.Fatal(err)
	}
	a := feedbackTestAttempt(t, store, feedbackTestPNG(t))
	_, err := AppendFeedbackReplyV2(db, root.ID, &user, ReplyFeedbackV2Input{ClientSubmissionID: feedbackAttemptID(t)}, a, true, "")
	a.Close()
	db.Callback().Query().Remove("revoke-upload")
	if !errors.Is(err, ErrFeedbackAdminRequired) {
		t.Fatal("stale owner authority survived upload:", err)
	}
	var count int64
	db.Model(&model.FeedbackReply{}).Count(&count)
	if count != 0 {
		t.Fatal("revoked admin published a member reply through admin route")
	}
}

func TestFeedbackV2OwnerImageReplyReconcilesUncertainCommit(t *testing.T) {
	db := grantDB(t)
	store := feedbackTestStore(t)
	owner := feedbackUser(t, db, "uncertain-owner", true)
	root := createFeedback(t, db, &owner, "issue", "root", true)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	faultDB := db.Session(&gorm.Session{NewDB: true, Context: ctx})
	faultDB.Statement.ConnPool = &feedbackUncertainPool{ConnPool: db.Statement.ConnPool, cancel: cancel}
	input := ReplyFeedbackV2Input{ClientSubmissionID: feedbackAttemptID(t)}
	a := feedbackTestAttempt(t, store, feedbackTestPNG(t))
	reply, err := AppendFeedbackReplyV2(faultDB, root.ID, &owner, input, a, true, "127.0.0.1")
	a.Close()
	if err != nil || reply == nil || reply.AuthorRole != FeedbackRoleOwner || len(reply.Images) != 1 {
		t.Fatalf("owner reply did not reconcile after cancelled commit acknowledgement: %+v %v", reply, err)
	}
	retry := feedbackTestAttempt(t, store, feedbackTestPNG(t))
	again, err := AppendFeedbackReplyV2(db, root.ID, &owner, input, retry, true, "127.0.0.1")
	retry.Close()
	if err != nil || again.ID != reply.ID || len(again.Images) != 1 || again.Images[0].ID != reply.Images[0].ID {
		t.Fatalf("owner reply retry duplicated publication: %+v %v", again, err)
	}
	for _, record := range []any{&model.FeedbackReply{}, &model.FeedbackImage{}, &model.AdminLog{}} {
		var count int64
		if err := db.Model(record).Count(&count).Error; err != nil || count != 1 {
			t.Fatalf("uncertain owner reply must publish one %T: count=%d err=%v", record, count, err)
		}
	}
	legacy, err := GetFeedbackDetail(db, root.ID, &owner, 1, 20)
	if err != nil || legacy.Replies.Total != 1 || len(legacy.Replies.Items) != 1 || !strings.Contains(legacy.Replies.Items[0].Content, "刷新") {
		t.Fatalf("legacy image-only owner reply lost its refresh hint: %+v %v", legacy, err)
	}
	row, err := AuthorizeFeedbackImage(db, reply.Images[0].ID, &owner)
	if err != nil {
		t.Fatal(err)
	}
	for _, variant := range []string{"original", "thumbnail"} {
		file, _, _, err := store.OpenImage(*row, variant)
		if err != nil {
			t.Fatalf("uncertain commit lost published %s: %v", variant, err)
		}
		file.Close()
	}
	input.Content = "different reply with the same attempt ID"
	changed := feedbackTestAttempt(t, store, feedbackTestPNG(t))
	_, err = AppendFeedbackReplyV2(db, root.ID, &owner, input, changed, true, "127.0.0.1")
	changed.Close()
	if !errors.Is(err, ErrFeedbackSubmissionConflict) {
		t.Fatalf("changed owner reply reused its attempt ID: %v", err)
	}
}
