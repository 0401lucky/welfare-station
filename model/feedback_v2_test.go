package model

import (
	"strings"
	"testing"
	"time"

	"welfare/internal/feedbacktest"

	"gorm.io/gorm"
)

// Deliberately frozen V1 schemas: using today's model to seed would not prove
// that migration adds columns/defaults while preserving real old rows.
type feedbackV1Fixture struct {
	ID        int64  `gorm:"primaryKey;autoIncrement"`
	UserID    int64  `gorm:"not null"`
	Category  string `gorm:"type:varchar(16);not null"`
	Content   string `gorm:"type:text;not null"`
	IsPrivate bool   `gorm:"not null;default:false"`
	IsHidden  bool   `gorm:"not null;default:false"`
	Status    string `gorm:"type:varchar(16);not null;default:''"`
	CreatedAt time.Time
	UpdatedAt time.Time
}

func (feedbackV1Fixture) TableName() string { return "w_feedbacks" }

type feedbackReplyV1Fixture struct {
	ID          int64  `gorm:"primaryKey;autoIncrement"`
	FeedbackID  int64  `gorm:"not null"`
	AdminUserID int64  `gorm:"not null"`
	Content     string `gorm:"type:text;not null"`
	CreatedAt   time.Time
}

func (feedbackReplyV1Fixture) TableName() string { return "w_feedback_replies" }

func verifyFeedbackV2Migration(t *testing.T, db *gorm.DB) {
	t.Helper()
	if err := db.AutoMigrate(&feedbackV1Fixture{}, &feedbackReplyV1Fixture{}); err != nil {
		t.Fatal(err)
	}
	oldTime := time.Date(2025, 1, 2, 3, 4, 5, 0, time.UTC)
	root := feedbackV1Fixture{ID: 410, UserID: 11, Category: "issue", Content: "原有私密留言🍀", IsPrivate: true, IsHidden: true, Status: "in_progress", CreatedAt: oldTime, UpdatedAt: oldTime}
	reply := feedbackReplyV1Fixture{ID: 920, FeedbackID: root.ID, AdminUserID: 22, Content: "原有站主回复", CreatedAt: oldTime}
	if err := db.Create(&root).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Create(&reply).Error; err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 2; i++ {
		if err := Migrate(db); err != nil {
			t.Fatal(err)
		}
	}
	var saved Feedback
	if err := db.First(&saved, root.ID).Error; err != nil {
		t.Fatal(err)
	}
	if saved.Content != root.Content || saved.UserID != root.UserID || saved.Status != root.Status || !saved.IsPrivate || !saved.IsHidden || !saved.CreatedAt.Equal(oldTime) || saved.ClientSubmissionID != nil {
		t.Fatalf("V1 root altered: %+v", saved)
	}
	var savedReply FeedbackReply
	if err := db.First(&savedReply, reply.ID).Error; err != nil {
		t.Fatal(err)
	}
	if savedReply.Content != reply.Content || savedReply.UserID != reply.AdminUserID || savedReply.FeedbackID != root.ID || savedReply.AuthorRole != "owner" || savedReply.IsHidden || savedReply.ReplyToID != nil || savedReply.ClientSubmissionID != nil || !savedReply.CreatedAt.Equal(oldTime) {
		t.Fatalf("V1 reply altered: %+v", savedReply)
	}
	for i := 0; i < 2; i++ {
		if err := db.Create(&Feedback{UserID: root.UserID, Category: "message", Content: "legacy null key"}).Error; err != nil {
			t.Fatal(err)
		}
		if err := db.Create(&FeedbackReply{FeedbackID: root.ID, UserID: reply.AdminUserID, Content: "legacy null key"}).Error; err != nil {
			t.Fatal(err)
		}
	}
	key, hash := strings.Repeat("a", 32), strings.Repeat("b", 64)
	for _, record := range []any{
		&Feedback{UserID: root.UserID, Category: "message", Content: "first", ClientSubmissionID: &key, SubmissionHash: &hash},
		&FeedbackReply{FeedbackID: root.ID, UserID: reply.AdminUserID, AuthorRole: "member", Content: "member", ClientSubmissionID: &key, SubmissionHash: &hash},
	} {
		if err := db.Create(record).Error; err != nil {
			t.Fatal(err)
		}
	}
	if err := db.Create(&Feedback{UserID: root.UserID, Category: "message", Content: "duplicate", ClientSubmissionID: &key}).Error; err == nil {
		t.Fatal("root duplicate retry key accepted")
	}
	if err := db.Create(&FeedbackReply{FeedbackID: root.ID, UserID: reply.AdminUserID, Content: "duplicate", ClientSubmissionID: &key}).Error; err == nil {
		t.Fatal("reply duplicate retry key accepted")
	}
	for _, hidden := range []bool{true, false} {
		if err := db.Model(&FeedbackReply{}).Where("id = ?", reply.ID).Update("is_hidden", hidden).Error; err != nil {
			t.Fatal(err)
		}
		if err := db.First(&savedReply, reply.ID).Error; err != nil || savedReply.IsHidden != hidden {
			t.Fatalf("explicit hidden update %v: %v", hidden, err)
		}
	}
	for _, test := range []struct {
		model any
		index string
	}{
		{&Feedback{}, "uk_feedback_submission"}, {&FeedbackReply{}, "uk_feedback_reply_submission"}, {&FeedbackReply{}, "idx_feedback_participant"}, {&FeedbackReply{}, "idx_feedback_reply_visible"}, {&FeedbackImage{}, "idx_feedback_image_parent"},
	} {
		if !db.Migrator().HasIndex(test.model, test.index) {
			t.Errorf("missing index %s", test.index)
		}
	}
	if db.Migrator().HasColumn(&FeedbackReply{}, "user_id") {
		t.Fatal("migration renamed or copied legacy author column")
	}
}

func TestFeedbackV2PopulatedMigrationSQLite(t *testing.T) { verifyFeedbackV2Migration(t, testDB(t)) }
func TestFeedbackV2PopulatedMigrationMySQL(t *testing.T) {
	verifyFeedbackV2Migration(t, feedbacktest.MySQL(t))
}
