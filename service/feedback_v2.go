package service

import (
	"errors"
	"time"

	"welfare/model"

	"gorm.io/gorm"
)

const (
	FeedbackRoleOwner  = "owner"
	FeedbackRoleMember = "member"
)

type FeedbackImage struct {
	ID           string `json:"id"`
	MIMEType     string `json:"mime_type"`
	Width        int    `json:"width"`
	Height       int    `json:"height"`
	ByteSize     int64  `json:"byte_size"`
	OriginalURL  string `json:"original_url"`
	ThumbnailURL string `json:"thumbnail_url"`
}

type FeedbackV2Item struct {
	FeedbackItem
	Images []FeedbackImage `json:"images"`
}

type AdminFeedbackV2Item struct {
	FeedbackV2Item
	UserID      int64  `json:"user_id"`
	LinuxDOName string `json:"linux_do_name"`
}

type FeedbackReplyTarget struct {
	ID     int64          `json:"id"`
	Author FeedbackAuthor `json:"author"`
}

type FeedbackV2Reply struct {
	ID                 int64                `json:"id"`
	Author             FeedbackAuthor       `json:"author"`
	AuthorRole         string               `json:"author_role"`
	Content            string               `json:"content"`
	Images             []FeedbackImage      `json:"images"`
	IsHidden           bool                 `json:"is_hidden"`
	CreatedAt          time.Time            `json:"created_at"`
	ReplyTo            *FeedbackReplyTarget `json:"reply_to"`
	ReplyToUnavailable bool                 `json:"reply_to_unavailable"`
}

type FeedbackV2Detail struct {
	Message  FeedbackV2Item                `json:"message"`
	Replies  FeedbackPage[FeedbackV2Reply] `json:"replies"`
	CanReply bool                          `json:"can_reply"`
}

type AdminFeedbackV2Detail struct {
	Message  AdminFeedbackV2Item           `json:"message"`
	Replies  FeedbackPage[FeedbackV2Reply] `json:"replies"`
	CanReply bool                          `json:"can_reply"`
}

func projectFeedbackImage(row model.FeedbackImage) FeedbackImage {
	base := "/api/v2/feedback/images/" + row.ID + "/"
	return FeedbackImage{ID: row.ID, MIMEType: row.MIMEType, Width: row.Width, Height: row.Height, ByteSize: row.ByteSize, OriginalURL: base + "original", ThumbnailURL: base + "thumbnail"}
}

// The caller supplies authorized root/reply IDs; attachments never broaden the
// set. Root galleries exclude reply images, including hidden reply images.
func loadFeedbackImages(db *gorm.DB, rootIDs, replyIDs []int64) (map[int64][]FeedbackImage, map[int64][]FeedbackImage, error) {
	roots, replies := make(map[int64][]FeedbackImage), make(map[int64][]FeedbackImage)
	if len(rootIDs)+len(replyIDs) == 0 {
		return roots, replies, nil
	}
	query := db.Where("(feedback_id IN ? AND reply_id IS NULL) OR reply_id IN ?", rootIDs, replyIDs)
	var rows []model.FeedbackImage
	if err := query.Order("position ASC").Find(&rows).Error; err != nil {
		return nil, nil, err
	}
	for _, row := range rows {
		if row.ReplyID == nil {
			roots[row.FeedbackID] = append(roots[row.FeedbackID], projectFeedbackImage(row))
		} else {
			replies[*row.ReplyID] = append(replies[*row.ReplyID], projectFeedbackImage(row))
		}
	}
	return roots, replies, nil
}

func nonNullFeedbackImages(images []FeedbackImage) []FeedbackImage {
	if images == nil {
		return []FeedbackImage{}
	}
	return images
}

func projectFeedbackV2Items(db *gorm.DB, rows []model.Feedback, viewer *model.User) ([]AdminFeedbackV2Item, error) {
	ids, userIDs := make([]int64, 0, len(rows)), make([]int64, 0, len(rows))
	for _, row := range rows {
		ids = append(ids, row.ID)
		userIDs = append(userIDs, row.UserID)
	}
	users, err := loadFeedbackUsers(db, userIDs)
	if err != nil {
		return nil, err
	}
	images, _, err := loadFeedbackImages(db, ids, nil)
	if err != nil {
		return nil, err
	}
	counts := make(map[int64]int64)
	if len(ids) > 0 {
		var grouped []struct {
			FeedbackID int64
			Total      int64
		}
		if err := feedbackReplyScope(db.Model(&model.FeedbackReply{}), viewer).Select("feedback_id, COUNT(*) AS total").Where("feedback_id IN ?", ids).Group("feedback_id").Scan(&grouped).Error; err != nil {
			return nil, err
		}
		for _, row := range grouped {
			counts[row.FeedbackID] = row.Total
		}
	}
	out := make([]AdminFeedbackV2Item, 0, len(rows))
	for _, row := range rows {
		item := projectFeedbackItem(row, users[row.UserID], counts[row.ID])
		item.Content = row.Content // V1's image-only refresh hint is not a V2 body.
		out = append(out, AdminFeedbackV2Item{FeedbackV2Item: FeedbackV2Item{FeedbackItem: item, Images: nonNullFeedbackImages(images[row.ID])}, UserID: row.UserID, LinuxDOName: users[row.UserID].LinuxDOName})
	}
	return out, nil
}

func listFeedbackV2(db *gorm.DB, identity *model.User, scope string, filters FeedbackFilters) (FeedbackPage[AdminFeedbackV2Item], error) {
	admin := scope == "admin"
	filters, err := normalizeFeedbackFilters(filters, admin)
	out := FeedbackPage[AdminFeedbackV2Item]{Items: []AdminFeedbackV2Item{}, Page: filters.Page, PageSize: filters.PageSize}
	if err != nil {
		return out, err
	}
	if scope != "public" && scope != "admin" && scope != "mine" && scope != "participated" {
		return out, FeedbackValidationError("留言视图无效")
	}
	err = db.Transaction(func(tx *gorm.DB) error {
		var viewer *model.User
		if scope != "public" {
			viewer, err = liveFeedbackUser(tx, identity, true, admin, false)
			if err != nil {
				return err
			}
		}
		query := tx.Model(&model.Feedback{})
		switch scope {
		case "public":
			query = feedbackParentScope(query, nil)
		case "mine":
			query = query.Where("user_id = ?", viewer.ID)
		case "participated":
			query = feedbackParentScope(query, viewer).Where("EXISTS (SELECT 1 FROM w_feedback_replies AS participation WHERE participation.feedback_id = w_feedbacks.id AND participation.admin_user_id = ?)", viewer.ID)
		}
		rows, total, queryErr := queryFeedbackRows(tx, query, filters)
		if queryErr != nil {
			return queryErr
		}
		out.Items, queryErr = projectFeedbackV2Items(tx, rows, viewer)
		out.Total = total
		return queryErr
	})
	return out, err
}

func ListFeedbackV2(db *gorm.DB, viewer *model.User, scope string, filters FeedbackFilters) (FeedbackPage[FeedbackV2Item], error) {
	if scope == "admin" {
		return FeedbackPage[FeedbackV2Item]{}, FeedbackValidationError("留言视图无效")
	}
	page, err := listFeedbackV2(db, viewer, scope, filters)
	out := FeedbackPage[FeedbackV2Item]{Items: []FeedbackV2Item{}, Total: page.Total, Page: page.Page, PageSize: page.PageSize}
	for _, item := range page.Items {
		out.Items = append(out.Items, item.FeedbackV2Item)
	}
	return out, err
}

func ListAdminFeedbackV2(db *gorm.DB, admin *model.User, filters FeedbackFilters) (FeedbackPage[AdminFeedbackV2Item], error) {
	return listFeedbackV2(db, admin, "admin", filters)
}

func projectFeedbackV2Replies(db *gorm.DB, rows []model.FeedbackReply, parentID int64, viewer *model.User) ([]FeedbackV2Reply, error) {
	ids, userIDs, targetIDs := make([]int64, 0, len(rows)), make([]int64, 0, len(rows)), make([]int64, 0, len(rows))
	for _, row := range rows {
		ids = append(ids, row.ID)
		userIDs = append(userIDs, row.UserID)
		if row.ReplyToID != nil {
			targetIDs = append(targetIDs, *row.ReplyToID)
		}
	}
	targets := make(map[int64]model.FeedbackReply)
	if len(targetIDs) > 0 {
		var targetRows []model.FeedbackReply
		// Do not even load an inaccessible target's text or images.
		if err := feedbackReplyScope(db, viewer).Select("id", "admin_user_id").Where("feedback_id = ? AND id IN ?", parentID, targetIDs).Find(&targetRows).Error; err != nil {
			return nil, err
		}
		for _, target := range targetRows {
			targets[target.ID] = target
			userIDs = append(userIDs, target.UserID)
		}
	}
	users, err := loadFeedbackUsers(db, userIDs)
	if err != nil {
		return nil, err
	}
	_, images, err := loadFeedbackImages(db, nil, ids)
	if err != nil {
		return nil, err
	}
	out := make([]FeedbackV2Reply, 0, len(rows))
	for _, row := range rows {
		item := FeedbackV2Reply{ID: row.ID, Author: projectFeedbackAuthor(users[row.UserID]), AuthorRole: row.AuthorRole, Content: row.Content, IsHidden: row.IsHidden, Images: nonNullFeedbackImages(images[row.ID]), CreatedAt: row.CreatedAt}
		if row.ReplyToID != nil {
			if target, ok := targets[*row.ReplyToID]; ok {
				item.ReplyTo = &FeedbackReplyTarget{ID: target.ID, Author: projectFeedbackAuthor(users[target.UserID])}
			} else {
				item.ReplyToUnavailable = true
			}
		}
		out = append(out, item)
	}
	return out, nil
}

func feedbackReplyNotFound(err error) error {
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return ErrFeedbackNotFound
	}
	return err
}

func readFeedbackV2Thread(db *gorm.DB, id int64, identity *model.User, page, size int, anchor int64, admin bool) (*AdminFeedbackV2Detail, error) {
	page, size = NormalizeFeedbackPagination(page, size)
	out := &AdminFeedbackV2Detail{Replies: FeedbackPage[FeedbackV2Reply]{Items: []FeedbackV2Reply{}, Page: page, PageSize: size}}
	err := db.Transaction(func(tx *gorm.DB) error {
		viewer, err := liveFeedbackUser(tx, identity, admin, admin, false)
		if err != nil {
			return err
		}
		parent, err := findFeedback(tx, id, viewer)
		if err != nil {
			return err
		}
		query := feedbackReplyScope(tx.Model(&model.FeedbackReply{}), viewer).Where("feedback_id = ?", id)
		if anchor > 0 {
			var row model.FeedbackReply
			if err := query.Session(&gorm.Session{}).Where("id = ?", anchor).First(&row).Error; err != nil {
				return feedbackReplyNotFound(err)
			}
			var preceding int64
			if err := query.Session(&gorm.Session{}).Where("id <= ?", anchor).Count(&preceding).Error; err != nil {
				return err
			}
			page = int((preceding-1)/int64(size)) + 1
			out.Replies.Page = page
		}
		if err := query.Count(&out.Replies.Total).Error; err != nil {
			return err
		}
		var rows []model.FeedbackReply
		if err := query.Order("id ASC").Offset((page - 1) * size).Limit(size).Find(&rows).Error; err != nil {
			return err
		}
		out.Replies.Items, err = projectFeedbackV2Replies(tx, rows, id, viewer)
		if err != nil {
			return err
		}
		items, err := projectFeedbackV2Items(tx, []model.Feedback{parent}, viewer)
		if err != nil {
			return err
		}
		out.Message, out.CanReply = items[0], activeFeedbackUser(viewer)
		return nil
	})
	if err != nil {
		return nil, err
	}
	return out, nil
}

func GetFeedbackDetailV2(db *gorm.DB, id int64, viewer *model.User, page, size int, anchor int64) (*FeedbackV2Detail, error) {
	detail, err := readFeedbackV2Thread(db, id, viewer, page, size, anchor, false)
	if err != nil {
		return nil, err
	}
	return &FeedbackV2Detail{Message: detail.Message.FeedbackV2Item, Replies: detail.Replies, CanReply: detail.CanReply}, nil
}

func GetAdminFeedbackDetailV2(db *gorm.DB, id int64, admin *model.User, page, size int, anchor int64) (*AdminFeedbackV2Detail, error) {
	return readFeedbackV2Thread(db, id, admin, page, size, anchor, true)
}

func getFeedbackReplyV2(db *gorm.DB, id, replyID int64, identity *model.User, admin bool) (*FeedbackV2Reply, error) {
	var out *FeedbackV2Reply
	err := db.Transaction(func(tx *gorm.DB) error {
		viewer, err := liveFeedbackUser(tx, identity, true, admin, false)
		if err != nil {
			return err
		}
		if _, err := findFeedback(tx, id, viewer); err != nil {
			return err
		}
		var row model.FeedbackReply
		if err := feedbackReplyScope(tx, viewer).Where("feedback_id = ? AND id = ?", id, replyID).First(&row).Error; err != nil {
			return feedbackReplyNotFound(err)
		}
		items, err := projectFeedbackV2Replies(tx, []model.FeedbackReply{row}, id, viewer)
		if err != nil {
			return err
		}
		out = &items[0]
		return nil
	})
	return out, err
}

// Authorize bytes in a single read snapshot, before opening either variant or
// handling conditional/HEAD requests. Participation never grants parent access.
func AuthorizeFeedbackImage(db *gorm.DB, imageID string, identity *model.User) (*model.FeedbackImage, error) {
	if !validFeedbackHex(imageID) {
		return nil, ErrFeedbackNotFound
	}
	var image model.FeedbackImage
	err := db.Transaction(func(tx *gorm.DB) error {
		viewer, err := liveFeedbackUser(tx, identity, false, false, false)
		if err != nil {
			return err
		}
		if err := tx.Where("id = ?", imageID).First(&image).Error; err != nil {
			return feedbackReplyNotFound(err)
		}
		if _, err := findFeedback(tx, image.FeedbackID, viewer); err != nil {
			return err
		}
		if image.ReplyID != nil {
			var reply model.FeedbackReply
			if err := feedbackReplyScope(tx, viewer).Select("id").Where("feedback_id = ? AND id = ?", image.FeedbackID, *image.ReplyID).First(&reply).Error; err != nil {
				return feedbackReplyNotFound(err)
			}
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return &image, nil
}
