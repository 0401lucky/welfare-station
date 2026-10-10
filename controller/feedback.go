package controller

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strconv"
	"unicode/utf8"

	"welfare/common"
	"welfare/middleware"
	"welfare/service"

	"github.com/gin-gonic/gin"
)

const feedbackMaxRequestBytes = 32 * 1024

// FeedbackNoStore runs before auth/rate guards, including their error responses.
func FeedbackNoStore(c *gin.Context) {
	c.Header("Cache-Control", "private, no-store")
	c.Next()
}

func bindFeedbackBody(c *gin.Context, body any) bool {
	raw, err := io.ReadAll(io.LimitReader(c.Request.Body, feedbackMaxRequestBytes+1))
	if err != nil || len(raw) > feedbackMaxRequestBytes {
		common.BadRequest(c, "留言请求过大或无法读取")
		return false
	}
	// encoding/json replaces invalid UTF-8 with U+FFFD; reject it before decoding.
	if !utf8.Valid(raw) {
		common.BadRequest(c, "留言请求必须是有效的 UTF-8 文本")
		return false
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(body); err != nil {
		common.BadRequest(c, "留言请求参数错误")
		return false
	}
	if err := decoder.Decode(&struct{}{}); err != io.EOF {
		common.BadRequest(c, "留言请求参数错误")
		return false
	}
	return true
}

func feedbackPageParams(c *gin.Context) (int, int) {
	page, _ := strconv.Atoi(c.Query("page"))
	pageSize, _ := strconv.Atoi(c.Query("page_size"))
	return service.NormalizeFeedbackPagination(page, pageSize)
}

func feedbackFilters(c *gin.Context, admin bool) service.FeedbackFilters {
	page, pageSize := feedbackPageParams(c)
	filters := service.FeedbackFilters{
		Category: c.Query("category"), Status: c.Query("status"), Page: page, PageSize: pageSize,
	}
	if admin {
		filters.Search, filters.Visibility, filters.Moderation = c.Query("search"), c.Query("visibility"), c.Query("moderation")
	}
	return filters
}

func feedbackID(c *gin.Context) (int64, bool) {
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil || id <= 0 {
		common.BadRequest(c, "留言编号无效")
		return 0, false
	}
	return id, true
}

func feedbackError(c *gin.Context, err error, fallback string) {
	var validation service.FeedbackValidationError
	switch {
	case errors.Is(err, service.ErrFeedbackNotFound):
		common.Fail(c, http.StatusNotFound, service.ErrFeedbackNotFound.Error())
	case errors.Is(err, service.ErrFeedbackLoginRequired):
		common.Unauthorized(c, service.ErrFeedbackLoginRequired.Error())
	case errors.Is(err, service.ErrFeedbackAdminRequired):
		common.Forbidden(c, service.ErrFeedbackAdminRequired.Error())
	case errors.Is(err, service.ErrFeedbackImageLimit), errors.Is(err, service.ErrFeedbackRequestLimit):
		common.Fail(c, http.StatusRequestEntityTooLarge, err.Error())
	case errors.Is(err, service.ErrFeedbackImageFormat):
		common.Fail(c, http.StatusUnsupportedMediaType, service.ErrFeedbackImageFormat.Error())
	case errors.Is(err, service.ErrFeedbackImageStore):
		common.Fail(c, http.StatusServiceUnavailable, service.ErrFeedbackImageStore.Error())
	case errors.Is(err, service.ErrFeedbackSubmissionConflict):
		common.Fail(c, http.StatusConflict, service.ErrFeedbackSubmissionConflict.Error())
	case errors.As(err, &validation):
		common.BadRequest(c, validation.Error())
	default:
		common.InternalError(c, fallback)
	}
}

// GET /api/feedback — always the public wall, regardless of the current session.
func (a *App) ListFeedback(c *gin.Context) {
	page, err := service.ListPublicFeedback(a.DB.WithContext(c.Request.Context()), feedbackFilters(c, false))
	if err != nil {
		feedbackError(c, err, "读取留言列表失败")
		return
	}
	common.Ok(c, page)
}

// GET /api/user/feedback — no client-provided user ID is accepted.
func (a *App) MyFeedback(c *gin.Context) {
	page, err := service.ListMyFeedback(a.DB.WithContext(c.Request.Context()), middleware.CurrentUser(c), feedbackFilters(c, false))
	if err != nil {
		feedbackError(c, err, "读取我的留言失败")
		return
	}
	common.Ok(c, page)
}

// GET /api/feedback/:id — replies inherit the parent entry's permission.
func (a *App) FeedbackDetail(c *gin.Context) {
	id, ok := feedbackID(c)
	if !ok {
		return
	}
	page, pageSize := feedbackPageParams(c)
	detail, err := service.GetFeedbackDetail(a.DB.WithContext(c.Request.Context()), id, middleware.CurrentUser(c), page, pageSize)
	if err != nil {
		feedbackError(c, err, "读取留言失败")
		return
	}
	common.Ok(c, detail)
}

// POST /api/feedback — login is enough; no new-api binding is involved.
func (a *App) CreateFeedback(c *gin.Context) {
	var input service.CreateFeedbackInput
	if !bindFeedbackBody(c, &input) {
		return
	}
	item, err := service.CreateFeedback(a.DB.WithContext(c.Request.Context()), middleware.CurrentUser(c), input)
	if err != nil {
		feedbackError(c, err, "发布留言失败")
		return
	}
	common.Ok(c, item)
}

// GET /api/admin/feedback
func (a *App) AdminListFeedback(c *gin.Context) {
	page, err := service.ListAdminFeedback(a.DB.WithContext(c.Request.Context()), middleware.CurrentUser(c), feedbackFilters(c, true))
	if err != nil {
		feedbackError(c, err, "读取留言列表失败")
		return
	}
	common.Ok(c, page)
}

// GET /api/admin/feedback/:id
func (a *App) AdminFeedbackDetail(c *gin.Context) {
	id, ok := feedbackID(c)
	if !ok {
		return
	}
	page, pageSize := feedbackPageParams(c)
	detail, err := service.GetAdminFeedbackDetail(a.DB.WithContext(c.Request.Context()), id, middleware.CurrentUser(c), page, pageSize)
	if err != nil {
		feedbackError(c, err, "读取留言失败")
		return
	}
	common.Ok(c, detail)
}

// POST /api/admin/feedback/:id/replies
func (a *App) AdminReplyFeedback(c *gin.Context) {
	id, ok := feedbackID(c)
	if !ok {
		return
	}
	var input struct {
		Content string `json:"content"`
	}
	if !bindFeedbackBody(c, &input) {
		return
	}
	reply, err := service.AppendFeedbackReply(a.DB.WithContext(c.Request.Context()), id, middleware.CurrentUser(c), input.Content)
	if err != nil {
		feedbackError(c, err, "发送回复失败")
		return
	}
	a.audit(c, service.AuditReplyFeedback, service.AuditTargetFeedback, id, gin.H{
		"reply_id": reply.ID, "character_count": utf8.RuneCountInString(reply.Content),
	})
	common.Ok(c, reply)
}

// PUT /api/admin/feedback/:id/status
func (a *App) AdminUpdateFeedbackStatus(c *gin.Context) {
	id, ok := feedbackID(c)
	if !ok {
		return
	}
	var input struct {
		Status string `json:"status"`
	}
	if !bindFeedbackBody(c, &input) {
		return
	}
	change, err := service.UpdateFeedbackStatus(a.DB.WithContext(c.Request.Context()), id, middleware.CurrentUser(c), input.Status)
	if err != nil {
		feedbackError(c, err, "更新处理状态失败")
		return
	}
	if change.Changed {
		a.audit(c, service.AuditUpdateFeedbackStatus, service.AuditTargetFeedback, id, service.AuditDiff{
			Before: gin.H{"status": change.PreviousStatus}, After: gin.H{"status": change.Item.Status},
		})
	}
	common.Ok(c, change.Item)
}

// PUT /api/admin/feedback/:id/moderation
func (a *App) AdminModerateFeedback(c *gin.Context) {
	id, ok := feedbackID(c)
	if !ok {
		return
	}
	var input struct {
		IsHidden *bool `json:"is_hidden"`
	}
	if !bindFeedbackBody(c, &input) {
		return
	}
	if input.IsHidden == nil {
		common.BadRequest(c, "请明确指定是否隐藏留言")
		return
	}
	change, err := service.UpdateFeedbackModeration(a.DB.WithContext(c.Request.Context()), id, middleware.CurrentUser(c), *input.IsHidden)
	if err != nil {
		feedbackError(c, err, "更新留言显示状态失败")
		return
	}
	if change.Changed {
		action := service.AuditHideFeedback
		if !change.Item.IsHidden {
			action = service.AuditRestoreFeedback
		}
		a.audit(c, action, service.AuditTargetFeedback, id, service.AuditDiff{
			Before: gin.H{"is_hidden": change.PreviousHidden}, After: gin.H{"is_hidden": change.Item.IsHidden},
		})
	}
	common.Ok(c, change.Item)
}
