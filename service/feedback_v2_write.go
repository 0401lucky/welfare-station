package service

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"strings"
	"time"
	"unicode/utf8"

	"welfare/model"

	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

type CreateFeedbackV2Input struct {
	ClientSubmissionID string `json:"client_submission_id"`
	Category           string `json:"category"`
	Content            string `json:"content"`
	IsPrivate          bool   `json:"is_private"`
}

type ReplyFeedbackV2Input struct {
	ClientSubmissionID string `json:"client_submission_id"`
	Content            string `json:"content"`
	ReplyToID          *int64 `json:"reply_to_id,omitempty"`
}

// Bounded in-process author locks avoid competing SQLite read-to-write upgrades
// and unnecessary duplicate image work. SQL unique indexes remain authoritative
// across processes/restarts. Waiting respects the request's deadline.
var feedbackSubmissionLocks = func() [64]chan struct{} {
	var locks [64]chan struct{}
	for i := range locks {
		locks[i] = make(chan struct{}, 1)
	}
	return locks
}()

func lockFeedbackSubmission(ctx context.Context, author int64) (func(), error) {
	lock := feedbackSubmissionLocks[uint64(author)%uint64(len(feedbackSubmissionLocks))]
	select {
	case lock <- struct{}{}:
		return func() { <-lock }, nil
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

func normalizeFeedbackV2Text(content string, imageCount int) (string, error) {
	if !utf8.ValidString(content) {
		return "", FeedbackValidationError("留言或回复必须是有效的 UTF-8 文本")
	}
	content = strings.TrimSpace(content)
	if utf8.RuneCountInString(content) > FeedbackMaxContentRunes {
		return "", FeedbackValidationError("留言或回复不能超过 2000 字")
	}
	if content == "" && imageCount == 0 {
		return "", FeedbackValidationError("请输入文字或选择至少一张图片")
	}
	return content, nil
}

func feedbackSubmissionHash(kind string, parent int64, payload any, files []string) string {
	// JSON encodes explicit types and ordered hashes, avoiding ambiguous string
	// concatenation and excluding filenames/MIME declarations from the identity.
	raw, _ := json.Marshal(struct {
		Kind    string
		Parent  int64
		Payload any
		Files   []string
	}{kind, parent, payload, files})
	sum := sha256.Sum256(raw)
	return hex.EncodeToString(sum[:])
}

func matchingFeedbackHash(saved *string, expected string) error {
	if saved == nil || *saved != expected {
		return ErrFeedbackSubmissionConflict
	}
	return nil
}

func findFeedbackSubmission(db *gorm.DB, author int64, key, hash string) (*model.Feedback, error) {
	var row model.Feedback
	err := db.Where("user_id = ? AND client_submission_id = ?", author, key).First(&row).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if err := matchingFeedbackHash(row.SubmissionHash, hash); err != nil {
		return nil, err
	}
	return &row, nil
}

func findReplySubmission(db *gorm.DB, author int64, key, hash string) (*model.FeedbackReply, error) {
	var row model.FeedbackReply
	err := db.Where("admin_user_id = ? AND client_submission_id = ?", author, key).First(&row).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if err := matchingFeedbackHash(row.SubmissionHash, hash); err != nil {
		return nil, err
	}
	return &row, nil
}

func CreateFeedbackV2(db *gorm.DB, identity *model.User, input CreateFeedbackV2Input, attempt *FeedbackImageAttempt) (*FeedbackV2Item, error) {
	if !activeFeedbackUser(identity) {
		return nil, ErrFeedbackLoginRequired
	}
	if !validFeedbackHex(input.ClientSubmissionID) {
		return nil, FeedbackValidationError("发送标识无效，请重新发送")
	}
	if !IsFeedbackCategory(input.Category) {
		return nil, FeedbackValidationError("请选择有效的留言类别")
	}
	content, err := normalizeFeedbackV2Text(input.Content, attempt.Count())
	if err != nil {
		return nil, err
	}
	input.Content = content
	hash := feedbackSubmissionHash("message", 0, input, attempt.hashes())
	unlock, err := lockFeedbackSubmission(db.Statement.Context, identity.ID)
	if err != nil {
		return nil, err
	}
	defer unlock()
	if _, err := liveFeedbackUser(db, identity, true, false, false); err != nil {
		return nil, err
	}
	previous, err := findFeedbackSubmission(db, identity.ID, input.ClientSubmissionID, hash)
	if err != nil {
		return nil, err
	}
	if previous != nil {
		return readCreatedFeedbackV2(db, previous.ID, identity)
	}
	images, err := attempt.Prepare(db.Statement.Context)
	if err != nil {
		return nil, err
	}
	row := model.Feedback{UserID: identity.ID, Category: input.Category, Content: content, IsPrivate: input.IsPrivate, ClientSubmissionID: &input.ClientSubmissionID, SubmissionHash: &hash}
	if FeedbackHasStatus(row.Category) {
		row.Status = FeedbackStatusPending
	}
	err = db.Transaction(func(tx *gorm.DB) error {
		if _, err := liveFeedbackUser(tx, identity, true, false, true); err != nil {
			return err
		}
		// A second process can have won since the initial lookup. Locking the
		// author serializes this check before the unique-key insert on MySQL.
		previous, err := findFeedbackSubmission(tx, identity.ID, input.ClientSubmissionID, hash)
		if err != nil {
			return err
		}
		if previous != nil {
			row = *previous
			return nil
		}
		if err := tx.Create(&row).Error; err != nil {
			return err
		}
		return createFeedbackImageRows(tx, images, row.ID, nil)
	})
	if err != nil {
		// Commit acknowledgement and HTTP cancellation can be uncertain. Use a
		// bounded fresh context to reconcile; never delete final files here.
		recoveryCtx, cancel := context.WithTimeout(context.WithoutCancel(db.Statement.Context), 5*time.Second)
		defer cancel()
		recoveryDB := db.WithContext(recoveryCtx)
		previous, recoveryErr := findFeedbackSubmission(recoveryDB, identity.ID, input.ClientSubmissionID, hash)
		if recoveryErr == nil && previous != nil {
			return readCreatedFeedbackV2(recoveryDB, previous.ID, identity)
		}
		if errors.Is(recoveryErr, ErrFeedbackSubmissionConflict) {
			return nil, recoveryErr
		}
		return nil, err
	}
	return readCreatedFeedbackV2(db, row.ID, identity)
}

func readCreatedFeedbackV2(db *gorm.DB, id int64, identity *model.User) (*FeedbackV2Item, error) {
	// Replays are writes from the client's perspective: a now-disabled identity
	// must not regain write permission just because its old public row exists.
	if _, err := liveFeedbackUser(db, identity, true, false, false); err != nil {
		return nil, err
	}
	detail, err := GetFeedbackDetailV2(db, id, identity, 1, 1, 0)
	if err != nil {
		return nil, err
	}
	return &detail.Message, nil
}

func createFeedbackImageRows(tx *gorm.DB, images []model.FeedbackImage, parent int64, reply *int64) error {
	for i := range images {
		images[i].FeedbackID, images[i].ReplyID = parent, reply
	}
	if len(images) == 0 {
		return nil
	}
	return tx.Create(&images).Error
}

func AppendFeedbackReplyV2(db *gorm.DB, id int64, identity *model.User, input ReplyFeedbackV2Input, attempt *FeedbackImageAttempt, requireAdmin bool, ip string) (*FeedbackV2Reply, error) {
	if !activeFeedbackUser(identity) {
		return nil, ErrFeedbackLoginRequired
	}
	if requireAdmin {
		if err := requireFeedbackAdmin(identity); err != nil {
			return nil, err
		}
	}
	if !validFeedbackHex(input.ClientSubmissionID) {
		return nil, FeedbackValidationError("发送标识无效，请重新发送")
	}
	if input.ReplyToID != nil && *input.ReplyToID <= 0 {
		return nil, FeedbackValidationError("回复目标编号无效")
	}
	content, err := normalizeFeedbackV2Text(input.Content, attempt.Count())
	if err != nil {
		return nil, err
	}
	input.Content = content
	hash := feedbackSubmissionHash("reply", id, input, attempt.hashes())
	unlock, err := lockFeedbackSubmission(db.Statement.Context, identity.ID)
	if err != nil {
		return nil, err
	}
	defer unlock()
	viewer, err := liveFeedbackUser(db, identity, true, requireAdmin, false)
	if err != nil {
		return nil, err
	}
	if _, err := findFeedback(db, id, viewer); err != nil {
		return nil, err
	}
	previous, err := findReplySubmission(db, identity.ID, input.ClientSubmissionID, hash)
	if err != nil {
		return nil, err
	}
	if previous != nil {
		return getFeedbackReplyV2(db, id, previous.ID, identity, requireAdmin)
	}
	images, err := attempt.Prepare(db.Statement.Context)
	if err != nil {
		return nil, err
	}
	row := model.FeedbackReply{FeedbackID: id, UserID: identity.ID, Content: content, ReplyToID: input.ReplyToID, ClientSubmissionID: &input.ClientSubmissionID, SubmissionHash: &hash}
	err = db.Transaction(func(tx *gorm.DB) error {
		// Always parent first, then live author, then target. Root/reply
		// moderation shares this order and cannot race a target permission check.
		var parent model.Feedback
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).First(&parent, id).Error; err != nil {
			return feedbackReplyNotFound(err)
		}
		viewer, err := liveFeedbackUser(tx, identity, true, requireAdmin, true)
		if err != nil {
			return err
		}
		if _, err := findFeedback(tx, id, viewer); err != nil {
			return err
		}
		previous, err := findReplySubmission(tx, identity.ID, input.ClientSubmissionID, hash)
		if err != nil {
			return err
		}
		if previous != nil {
			row = *previous
			return nil
		}
		if input.ReplyToID != nil {
			var target model.FeedbackReply
			if err := feedbackReplyScope(tx.Clauses(clause.Locking{Strength: "UPDATE"}), viewer).First(&target, *input.ReplyToID).Error; err != nil {
				return feedbackReplyNotFound(err)
			}
			if target.FeedbackID != id {
				// Knowing an ID in a private conversation is not authority to
				// learn that it exists through a target-relationship error.
				if _, err := findFeedback(tx, target.FeedbackID, viewer); err != nil {
					return err
				}
				return FeedbackValidationError("回复目标不属于这条留言")
			}
		}
		row.AuthorRole = FeedbackRoleMember
		if viewer.IsAdmin {
			row.AuthorRole = FeedbackRoleOwner
		}
		if err := tx.Create(&row).Error; err != nil {
			return err
		}
		if err := createFeedbackImageRows(tx, images, id, &row.ID); err != nil {
			return err
		}
		if err := tx.Model(&model.Feedback{}).Where("id = ?", id).Update("updated_at", row.CreatedAt).Error; err != nil {
			return err
		}
		if viewer.IsAdmin {
			return recordFeedbackAudit(tx, viewer, AuditReplyFeedback, AuditTargetFeedback, id, map[string]any{"reply_id": row.ID, "character_count": utf8.RuneCountInString(content), "image_count": len(images)}, ip)
		}
		return nil
	})
	if err != nil {
		recoveryCtx, cancel := context.WithTimeout(context.WithoutCancel(db.Statement.Context), 5*time.Second)
		defer cancel()
		recoveryDB := db.WithContext(recoveryCtx)
		previous, recoveryErr := findReplySubmission(recoveryDB, identity.ID, input.ClientSubmissionID, hash)
		if recoveryErr == nil && previous != nil {
			return getFeedbackReplyV2(recoveryDB, id, previous.ID, identity, requireAdmin)
		}
		if errors.Is(recoveryErr, ErrFeedbackSubmissionConflict) {
			return nil, recoveryErr
		}
		return nil, err
	}
	return getFeedbackReplyV2(db, id, row.ID, identity, requireAdmin)
}

// V2 feedback actions are local SQL-only publications. Their audit belongs in
// the transaction, unlike external quota grants and the legacy V1 controller.
func recordFeedbackAudit(tx *gorm.DB, actor *model.User, action, target string, id int64, detail any, ip string) error {
	return tx.Create(&model.AdminLog{AdminUserID: actor.ID, Action: action, TargetType: target, TargetID: id, Detail: marshalAuditDetail(detail), IP: ip}).Error
}

func ModerateFeedbackReplyV2(db *gorm.DB, id, replyID int64, identity *model.User, hidden bool, ip string) (*FeedbackV2Reply, error) {
	if err := requireFeedbackAdmin(identity); err != nil {
		return nil, err
	}
	err := db.Transaction(func(tx *gorm.DB) error {
		var parent model.Feedback
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).First(&parent, id).Error; err != nil {
			return feedbackReplyNotFound(err)
		}
		admin, err := liveFeedbackUser(tx, identity, true, true, true)
		if err != nil {
			return err
		}
		var reply model.FeedbackReply
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).Where("feedback_id = ? AND id = ?", id, replyID).First(&reply).Error; err != nil {
			return feedbackReplyNotFound(err)
		}
		if reply.IsHidden == hidden {
			return nil
		}
		before := reply.IsHidden
		if err := tx.Model(&reply).Update("is_hidden", hidden).Error; err != nil {
			return err
		}
		action := AuditHideFeedbackReply
		if !hidden {
			action = AuditRestoreFeedbackReply
		}
		return recordFeedbackAudit(tx, admin, action, AuditTargetFeedbackReply, replyID, map[string]any{"feedback_id": id, "before": map[string]any{"is_hidden": before}, "after": map[string]any{"is_hidden": hidden}}, ip)
	})
	if err != nil {
		return nil, err
	}
	return getFeedbackReplyV2(db, id, replyID, identity, true)
}
