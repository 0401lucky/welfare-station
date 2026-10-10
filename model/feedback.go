package model

import "time"

// Feedback keeps the author's audience choice separate from owner moderation.
// Category, content and IsPrivate are immutable after creation.
type Feedback struct {
	ID        int64  `gorm:"primaryKey;autoIncrement;index:idx_feedback_public,priority:3;index:idx_feedback_author,priority:2" json:"id"`
	UserID    int64  `gorm:"not null;index:idx_feedback_author,priority:1;uniqueIndex:uk_feedback_submission,priority:1" json:"user_id"`
	Category  string `gorm:"type:varchar(16);not null;index:idx_feedback_category_status,priority:1" json:"category"`
	Content   string `gorm:"type:text;not null" json:"content"`
	IsPrivate bool   `gorm:"not null;default:false;index:idx_feedback_public,priority:1" json:"is_private"`
	IsHidden  bool   `gorm:"not null;default:false;index:idx_feedback_public,priority:2" json:"is_hidden"`
	// Only issues and suggestions have a workflow status; other categories store ''.
	Status             string    `gorm:"type:varchar(16);not null;default:'';index:idx_feedback_category_status,priority:2" json:"status"`
	CreatedAt          time.Time `json:"created_at"`
	UpdatedAt          time.Time `json:"updated_at"`
	ClientSubmissionID *string   `gorm:"type:varchar(32);uniqueIndex:uk_feedback_submission,priority:2" json:"-"`
	SubmissionHash     *string   `gorm:"type:char(64)" json:"-"`
}

func (Feedback) TableName() string { return "w_feedbacks" }

// FeedbackReply is append-only and always inherits its parent entry's audience.
type FeedbackReply struct {
	ID         int64 `gorm:"primaryKey;autoIncrement;index:idx_feedback_reply_parent,priority:2;index:idx_feedback_reply_visible,priority:3" json:"id"`
	FeedbackID int64 `gorm:"not null;index:idx_feedback_reply_parent,priority:1;index:idx_feedback_reply_visible,priority:1;index:idx_feedback_participant,priority:2" json:"feedback_id"`
	// Keep the V1 physical column: historical authorship must never be rewritten.
	UserID             int64     `gorm:"column:admin_user_id;not null;index:idx_feedback_participant,priority:1;uniqueIndex:uk_feedback_reply_submission,priority:1" json:"-"`
	AuthorRole         string    `gorm:"type:varchar(16);not null;default:owner" json:"author_role"`
	ReplyToID          *int64    `gorm:"index" json:"reply_to_id"`
	IsHidden           bool      `gorm:"not null;default:false;index:idx_feedback_reply_visible,priority:2" json:"is_hidden"`
	Content            string    `gorm:"type:text;not null" json:"content"`
	CreatedAt          time.Time `json:"created_at"`
	ClientSubmissionID *string   `gorm:"type:varchar(32);uniqueIndex:uk_feedback_reply_submission,priority:2" json:"-"`
	SubmissionHash     *string   `gorm:"type:char(64)" json:"-"`
}

func (FeedbackReply) TableName() string { return "w_feedback_replies" }
