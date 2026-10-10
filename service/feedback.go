package service

import (
	"errors"
	"strings"
	"time"
	"unicode/utf8"

	"welfare/model"

	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

const (
	FeedbackCategoryMessage    = "message"
	FeedbackCategoryPraise     = "praise"
	FeedbackCategoryIssue      = "issue"
	FeedbackCategorySuggestion = "suggestion"
	FeedbackStatusPending      = "pending"
	FeedbackStatusInProgress   = "in_progress"
	FeedbackStatusResolved     = "resolved"
	FeedbackMaxContentRunes    = 2000
	FeedbackMaxSearchRunes     = 100
	FeedbackMaxPage            = 1000000
)

var (
	ErrFeedbackNotFound      = errors.New("留言不存在或无权查看")
	ErrFeedbackLoginRequired = errors.New("请先登录后再操作")
	ErrFeedbackAdminRequired = errors.New("需要管理员权限")
)

// FeedbackValidationError contains only safe, fixed validation messages.
type FeedbackValidationError string

func (e FeedbackValidationError) Error() string { return string(e) }

type FeedbackAuthor struct {
	Name      string `json:"name"`
	AvatarURL string `json:"avatar_url"`
}

// Public DTOs deliberately do not embed either persistence model or User.
type FeedbackItem struct {
	ID         int64          `json:"id"`
	Author     FeedbackAuthor `json:"author"`
	Category   string         `json:"category"`
	Content    string         `json:"content"`
	IsPrivate  bool           `json:"is_private"`
	IsHidden   bool           `json:"is_hidden"`
	Status     *string        `json:"status"`
	ReplyCount int64          `json:"reply_count"`
	CreatedAt  time.Time      `json:"created_at"`
	UpdatedAt  time.Time      `json:"updated_at"`
}

type AdminFeedbackItem struct {
	FeedbackItem
	UserID      int64  `json:"user_id"`
	LinuxDOName string `json:"linux_do_name"`
}

type FeedbackReply struct {
	ID        int64          `json:"id"`
	Author    FeedbackAuthor `json:"author"`
	Content   string         `json:"content"`
	CreatedAt time.Time      `json:"created_at"`
}

type FeedbackPage[T any] struct {
	Items    []T   `json:"items"`
	Total    int64 `json:"total"`
	Page     int   `json:"page"`
	PageSize int   `json:"page_size"`
}

type FeedbackDetail struct {
	Message FeedbackItem                `json:"message"`
	Replies FeedbackPage[FeedbackReply] `json:"replies"`
}

type AdminFeedbackDetail struct {
	Message AdminFeedbackItem           `json:"message"`
	Replies FeedbackPage[FeedbackReply] `json:"replies"`
}

type FeedbackFilters struct {
	Category   string
	Status     string
	Search     string
	Visibility string
	Moderation string
	Page       int
	PageSize   int
}

type CreateFeedbackInput struct {
	Category  string `json:"category"`
	Content   string `json:"content"`
	IsPrivate bool   `json:"is_private"`
}

func IsFeedbackCategory(category string) bool {
	switch category {
	case FeedbackCategoryMessage, FeedbackCategoryPraise, FeedbackCategoryIssue, FeedbackCategorySuggestion:
		return true
	}
	return false
}

func FeedbackHasStatus(category string) bool {
	return category == FeedbackCategoryIssue || category == FeedbackCategorySuggestion
}

func IsFeedbackStatus(status string) bool {
	switch status {
	case FeedbackStatusPending, FeedbackStatusInProgress, FeedbackStatusResolved:
		return true
	}
	return false
}

// NormalizeFeedbackText counts Unicode code points, preserving internal whitespace.
func NormalizeFeedbackText(content string) (string, error) {
	if !utf8.ValidString(content) {
		return "", FeedbackValidationError("留言或回复必须是有效的 UTF-8 文本")
	}
	content = strings.TrimSpace(content)
	if n := utf8.RuneCountInString(content); n < 1 || n > FeedbackMaxContentRunes {
		return "", FeedbackValidationError("留言或回复请输入 1–2000 字")
	}
	return content, nil
}

func NormalizeFeedbackPagination(page, pageSize int) (int, int) {
	if page < 1 || page > FeedbackMaxPage {
		page = 1
	}
	if pageSize < 1 || pageSize > 100 {
		pageSize = 20
	}
	return page, pageSize
}

func normalizeFeedbackFilters(filters FeedbackFilters, admin bool) (FeedbackFilters, error) {
	filters.Page, filters.PageSize = NormalizeFeedbackPagination(filters.Page, filters.PageSize)
	if filters.Category != "" && !IsFeedbackCategory(filters.Category) {
		return filters, FeedbackValidationError("留言类别无效")
	}
	if filters.Status != "" && !IsFeedbackStatus(filters.Status) {
		return filters, FeedbackValidationError("处理状态无效")
	}
	if !admin {
		// Admin-only parameters never widen a public/personal query's scope.
		filters.Search, filters.Visibility, filters.Moderation = "", "", ""
		return filters, nil
	}
	if filters.Visibility != "" && filters.Visibility != "public" && filters.Visibility != "private" {
		return filters, FeedbackValidationError("公开范围无效")
	}
	if filters.Moderation != "" && filters.Moderation != "visible" && filters.Moderation != "hidden" {
		return filters, FeedbackValidationError("显示状态无效")
	}
	filters.Search = strings.TrimSpace(filters.Search)
	if !utf8.ValidString(filters.Search) || utf8.RuneCountInString(filters.Search) > FeedbackMaxSearchRunes {
		return filters, FeedbackValidationError("搜索内容不能超过 100 字")
	}
	return filters, nil
}

func activeFeedbackUser(user *model.User) bool {
	return user != nil && user.ID > 0 && user.Status == 1
}

func requireFeedbackAdmin(user *model.User) error {
	if !activeFeedbackUser(user) {
		return ErrFeedbackLoginRequired
	}
	if !user.IsAdmin {
		return ErrFeedbackAdminRequired
	}
	return nil
}

func projectFeedbackAuthor(user model.User) FeedbackAuthor {
	name := strings.TrimSpace(user.DisplayName)
	if name == "" {
		name = strings.TrimSpace(user.LinuxDOName)
	}
	if name == "" {
		name = "小站用户"
	}
	return FeedbackAuthor{Name: name, AvatarURL: user.AvatarURL}
}

func projectFeedbackItem(row model.Feedback, user model.User, replyCount int64) FeedbackItem {
	var status *string
	if FeedbackHasStatus(row.Category) {
		status = &row.Status
	}
	return FeedbackItem{
		ID: row.ID, Author: projectFeedbackAuthor(user), Category: row.Category,
		Content: legacyFeedbackContent(row.Content), IsPrivate: row.IsPrivate, IsHidden: row.IsHidden,
		Status: status, ReplyCount: replyCount, CreatedAt: row.CreatedAt, UpdatedAt: row.UpdatedAt,
	}
}

func projectAdminFeedbackItem(row model.Feedback, user model.User, replyCount int64) AdminFeedbackItem {
	return AdminFeedbackItem{
		FeedbackItem: projectFeedbackItem(row, user, replyCount),
		UserID:       row.UserID, LinuxDOName: user.LinuxDOName,
	}
}

func projectFeedbackReply(row model.FeedbackReply, user model.User) FeedbackReply {
	return FeedbackReply{ID: row.ID, Author: projectFeedbackAuthor(user), Content: legacyFeedbackContent(row.Content), CreatedAt: row.CreatedAt}
}

func legacyFeedbackContent(content string) string {
	if content == "" {
		return "图片留言，请刷新页面查看"
	}
	return content
}

// loadFeedbackUsers reads only the fields allowed in feedback projections.
func loadFeedbackUsers(db *gorm.DB, ids []int64) (map[int64]model.User, error) {
	usersByID := make(map[int64]model.User, len(ids))
	unique := make([]int64, 0, len(ids))
	seen := make(map[int64]bool, len(ids))
	for _, id := range ids {
		if id > 0 && !seen[id] {
			seen[id] = true
			unique = append(unique, id)
		}
	}
	if len(unique) == 0 {
		return usersByID, nil
	}
	var users []model.User
	if err := db.Select("id", "display_name", "linux_do_name", "avatar_url").Where("id IN ?", unique).Find(&users).Error; err != nil {
		return nil, err
	}
	for _, user := range users {
		usersByID[user.ID] = user
	}
	return usersByID, nil
}

// queryFeedbackRows receives an already authorized query. Counts, search and
// profile/reply queries must never run against a broader set of messages.
func queryFeedbackRows(db, query *gorm.DB, filters FeedbackFilters) ([]model.Feedback, int64, error) {
	if filters.Category != "" {
		query = query.Where("category = ?", filters.Category)
	}
	if filters.Status != "" {
		query = query.Where("status = ?", filters.Status)
	}
	if filters.Visibility != "" {
		query = query.Where("is_private = ?", filters.Visibility == "private")
	}
	if filters.Moderation != "" {
		query = query.Where("is_hidden = ?", filters.Moderation == "hidden")
	}
	if filters.Search != "" {
		// '!' is explicit and portable to both SQLite and MySQL (including
		// NO_BACKSLASH_ESCAPES); every wildcard is matched literally.
		like := "%" + strings.NewReplacer("!", "!!", "%", "!%", "_", "!_").Replace(filters.Search) + "%"
		authors := db.Model(&model.User{}).Select("id").Where(
			"display_name LIKE ? ESCAPE '!' OR linux_do_name LIKE ? ESCAPE '!'", like, like)
		query = query.Where("(content LIKE ? ESCAPE '!' OR user_id IN (?))", like, authors)
	}
	var total int64
	if err := query.Count(&total).Error; err != nil {
		return nil, 0, err
	}
	rows := make([]model.Feedback, 0)
	if err := query.Order("id DESC").Offset((filters.Page - 1) * filters.PageSize).Limit(filters.PageSize).Find(&rows).Error; err != nil {
		return nil, 0, err
	}
	return rows, total, nil
}

func feedbackProjectionData(db *gorm.DB, rows []model.Feedback, viewers ...*model.User) (map[int64]model.User, map[int64]int64, error) {
	var viewer *model.User
	if len(viewers) > 0 {
		viewer = viewers[0]
	}
	ids := make([]int64, 0, len(rows))
	userIDs := make([]int64, 0, len(rows))
	for _, row := range rows {
		ids = append(ids, row.ID)
		userIDs = append(userIDs, row.UserID)
	}
	users, err := loadFeedbackUsers(db, userIDs)
	if err != nil {
		return nil, nil, err
	}
	counts := make(map[int64]int64, len(rows))
	if len(ids) > 0 {
		var grouped []struct {
			FeedbackID int64
			Total      int64
		}
		if err := feedbackReplyScope(db.Model(&model.FeedbackReply{}), viewer).Where("author_role = ?", FeedbackRoleOwner).Select("feedback_id, COUNT(*) AS total").
			Where("feedback_id IN ?", ids).Group("feedback_id").Scan(&grouped).Error; err != nil {
			return nil, nil, err
		}
		for _, count := range grouped {
			counts[count.FeedbackID] = count.Total
		}
	}
	return users, counts, nil
}

func listFeedback(db, query *gorm.DB, filters FeedbackFilters, viewers ...*model.User) (FeedbackPage[FeedbackItem], error) {
	out := FeedbackPage[FeedbackItem]{Items: []FeedbackItem{}, Page: filters.Page, PageSize: filters.PageSize}
	rows, total, err := queryFeedbackRows(db, query, filters)
	if err != nil {
		return out, err
	}
	users, counts, err := feedbackProjectionData(db, rows, viewers...)
	if err != nil {
		return out, err
	}
	out.Total = total
	for _, row := range rows {
		out.Items = append(out.Items, projectFeedbackItem(row, users[row.UserID], counts[row.ID]))
	}
	return out, nil
}

func ListPublicFeedback(db *gorm.DB, filters FeedbackFilters) (FeedbackPage[FeedbackItem], error) {
	filters, err := normalizeFeedbackFilters(filters, false)
	if err != nil {
		return FeedbackPage[FeedbackItem]{}, err
	}
	query := db.Model(&model.Feedback{}).Where("is_private = ? AND is_hidden = ?", false, false)
	return listFeedback(db, query, filters)
}

func ListMyFeedback(db *gorm.DB, user *model.User, filters FeedbackFilters) (FeedbackPage[FeedbackItem], error) {
	if !activeFeedbackUser(user) {
		return FeedbackPage[FeedbackItem]{}, ErrFeedbackLoginRequired
	}
	filters, err := normalizeFeedbackFilters(filters, false)
	if err != nil {
		return FeedbackPage[FeedbackItem]{}, err
	}
	return listFeedback(db, db.Model(&model.Feedback{}).Where("user_id = ?", user.ID), filters, user)
}

func ListAdminFeedback(db *gorm.DB, admin *model.User, filters FeedbackFilters) (FeedbackPage[AdminFeedbackItem], error) {
	if err := requireFeedbackAdmin(admin); err != nil {
		return FeedbackPage[AdminFeedbackItem]{}, err
	}
	filters, err := normalizeFeedbackFilters(filters, true)
	if err != nil {
		return FeedbackPage[AdminFeedbackItem]{}, err
	}
	out := FeedbackPage[AdminFeedbackItem]{Items: []AdminFeedbackItem{}, Page: filters.Page, PageSize: filters.PageSize}
	rows, total, err := queryFeedbackRows(db, db.Model(&model.Feedback{}), filters)
	if err != nil {
		return out, err
	}
	users, counts, err := feedbackProjectionData(db, rows, admin)
	if err != nil {
		return out, err
	}
	out.Total = total
	for _, row := range rows {
		out.Items = append(out.Items, projectAdminFeedbackItem(row, users[row.UserID], counts[row.ID]))
	}
	return out, nil
}

func findFeedback(db *gorm.DB, id int64, viewer *model.User) (model.Feedback, error) {
	var row model.Feedback
	query := feedbackParentScope(db.Where("id = ?", id), viewer)
	err := query.First(&row).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		err = ErrFeedbackNotFound
	}
	return row, err
}

type feedbackThread struct {
	row     model.Feedback
	user    model.User
	replies FeedbackPage[FeedbackReply]
}

func readFeedbackThread(db *gorm.DB, id int64, viewer *model.User, page, pageSize int) (feedbackThread, error) {
	page, pageSize = NormalizeFeedbackPagination(page, pageSize)
	out := feedbackThread{replies: FeedbackPage[FeedbackReply]{Items: []FeedbackReply{}, Page: page, PageSize: pageSize}}
	// Keep the permission decision and reply page in the same read snapshot.
	err := db.Transaction(func(tx *gorm.DB) error {
		row, err := findFeedback(tx, id, viewer)
		if err != nil {
			return err
		}
		out.row = row
		query := feedbackReplyScope(tx.Model(&model.FeedbackReply{}), viewer).Where("feedback_id = ? AND author_role = ?", row.ID, FeedbackRoleOwner)
		if err := query.Count(&out.replies.Total).Error; err != nil {
			return err
		}
		var replies []model.FeedbackReply
		if err := query.Order("id ASC").Offset((page - 1) * pageSize).Limit(pageSize).Find(&replies).Error; err != nil {
			return err
		}
		userIDs := []int64{row.UserID}
		for _, reply := range replies {
			userIDs = append(userIDs, reply.UserID)
		}
		users, err := loadFeedbackUsers(tx, userIDs)
		if err != nil {
			return err
		}
		out.user = users[row.UserID]
		for _, reply := range replies {
			out.replies.Items = append(out.replies.Items, projectFeedbackReply(reply, users[reply.UserID]))
		}
		return nil
	})
	return out, err
}

func GetFeedbackDetail(db *gorm.DB, id int64, viewer *model.User, page, pageSize int) (*FeedbackDetail, error) {
	thread, err := readFeedbackThread(db, id, viewer, page, pageSize)
	if err != nil {
		return nil, err
	}
	return &FeedbackDetail{Message: projectFeedbackItem(thread.row, thread.user, thread.replies.Total), Replies: thread.replies}, nil
}

func GetAdminFeedbackDetail(db *gorm.DB, id int64, admin *model.User, page, pageSize int) (*AdminFeedbackDetail, error) {
	if err := requireFeedbackAdmin(admin); err != nil {
		return nil, err
	}
	thread, err := readFeedbackThread(db, id, admin, page, pageSize)
	if err != nil {
		return nil, err
	}
	return &AdminFeedbackDetail{Message: projectAdminFeedbackItem(thread.row, thread.user, thread.replies.Total), Replies: thread.replies}, nil
}

func CreateFeedback(db *gorm.DB, user *model.User, input CreateFeedbackInput) (*FeedbackItem, error) {
	if !activeFeedbackUser(user) {
		return nil, ErrFeedbackLoginRequired
	}
	if !IsFeedbackCategory(input.Category) {
		return nil, FeedbackValidationError("请选择有效的留言类别")
	}
	content, err := NormalizeFeedbackText(input.Content)
	if err != nil {
		return nil, err
	}
	row := model.Feedback{UserID: user.ID, Category: input.Category, Content: content, IsPrivate: input.IsPrivate}
	if FeedbackHasStatus(row.Category) {
		row.Status = FeedbackStatusPending
	}
	if err := db.Transaction(func(tx *gorm.DB) error {
		if _, err := liveFeedbackUser(tx, user, true, false, true); err != nil {
			return err
		}
		return tx.Create(&row).Error
	}); err != nil {
		return nil, err
	}
	item := projectFeedbackItem(row, *user, 0)
	return &item, nil
}

func AppendFeedbackReply(db *gorm.DB, id int64, admin *model.User, input string) (*FeedbackReply, error) {
	if err := requireFeedbackAdmin(admin); err != nil {
		return nil, err
	}
	content, err := NormalizeFeedbackText(input)
	if err != nil {
		return nil, err
	}
	row := model.FeedbackReply{FeedbackID: id, UserID: admin.ID, AuthorRole: FeedbackRoleOwner, Content: content}
	err = db.Transaction(func(tx *gorm.DB) error {
		if _, err := findFeedback(tx.Clauses(clause.Locking{Strength: "UPDATE"}), id, admin); err != nil {
			return err
		}
		if _, err := liveFeedbackUser(tx, admin, true, true, true); err != nil {
			return err
		}
		if err := tx.Create(&row).Error; err != nil {
			return err
		}
		return tx.Model(&model.Feedback{}).Where("id = ?", id).Update("updated_at", row.CreatedAt).Error
	})
	if err != nil {
		return nil, err
	}
	reply := projectFeedbackReply(row, *admin)
	return &reply, nil
}

// FeedbackChange returns the updated projection plus scalar before-state for auditing.
type FeedbackChange struct {
	Item           AdminFeedbackItem
	PreviousStatus string
	PreviousHidden bool
	Changed        bool
}

func changeFeedback(db *gorm.DB, id int64, admin *model.User, update func(model.Feedback) (map[string]any, error)) (*FeedbackChange, error) {
	if err := requireFeedbackAdmin(admin); err != nil {
		return nil, err
	}
	out := &FeedbackChange{}
	err := db.Transaction(func(tx *gorm.DB) error {
		row, err := findFeedback(tx.Clauses(clause.Locking{Strength: "UPDATE"}), id, admin)
		if err != nil {
			return err
		}
		if _, err := liveFeedbackUser(tx, admin, true, true, true); err != nil {
			return err
		}
		out.PreviousStatus, out.PreviousHidden = row.Status, row.IsHidden
		updates, err := update(row)
		if err != nil {
			return err
		}
		if len(updates) > 0 {
			if err := tx.Model(&row).Updates(updates).Error; err != nil {
				return err
			}
			out.Changed = true
		}
		users, counts, err := feedbackProjectionData(tx, []model.Feedback{row}, admin)
		if err != nil {
			return err
		}
		out.Item = projectAdminFeedbackItem(row, users[row.UserID], counts[row.ID])
		return nil
	})
	if err != nil {
		return nil, err
	}
	return out, nil
}

func UpdateFeedbackStatus(db *gorm.DB, id int64, admin *model.User, status string) (*FeedbackChange, error) {
	if !IsFeedbackStatus(status) {
		return nil, FeedbackValidationError("处理状态无效")
	}
	return changeFeedback(db, id, admin, func(row model.Feedback) (map[string]any, error) {
		if !FeedbackHasStatus(row.Category) {
			return nil, FeedbackValidationError("日常留言和夸夸小站不设置处理状态")
		}
		if row.Status == status {
			return nil, nil
		}
		return map[string]any{"status": status}, nil
	})
}

func UpdateFeedbackModeration(db *gorm.DB, id int64, admin *model.User, hidden bool) (*FeedbackChange, error) {
	return changeFeedback(db, id, admin, func(row model.Feedback) (map[string]any, error) {
		if row.IsHidden == hidden {
			return nil, nil
		}
		// Use a map so restoring false is not discarded as a zero value.
		return map[string]any{"is_hidden": hidden}, nil
	})
}
