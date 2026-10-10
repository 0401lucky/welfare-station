package model

import "time"

// FeedbackImage is immutable. Paths are derived from its generated ID and MIME,
// never from a client filename. A nil ReplyID attaches it to the root message.
type FeedbackImage struct {
	ID                string    `gorm:"type:char(32);primaryKey" json:"id"`
	FeedbackID        int64     `gorm:"not null;index:idx_feedback_image_parent,priority:1" json:"feedback_id"`
	ReplyID           *int64    `gorm:"index:idx_feedback_image_parent,priority:2;index" json:"reply_id"`
	Position          int       `gorm:"not null;index:idx_feedback_image_parent,priority:3" json:"position"`
	MIMEType          string    `gorm:"type:varchar(32);not null" json:"mime_type"`
	Width             int       `gorm:"not null" json:"width"`
	Height            int       `gorm:"not null" json:"height"`
	ByteSize          int64     `gorm:"not null" json:"byte_size"`
	ThumbnailMIMEType string    `gorm:"type:varchar(32);not null" json:"-"`
	ThumbnailByteSize int64     `gorm:"not null" json:"-"`
	CreatedAt         time.Time `json:"created_at"`
}

func (FeedbackImage) TableName() string { return "w_feedback_images" }
