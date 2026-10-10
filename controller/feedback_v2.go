package controller

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"mime/multipart"
	"net/http"
	"strconv"
	"time"
	"unicode/utf8"

	"welfare/common"
	"welfare/middleware"
	"welfare/service"

	"github.com/gin-gonic/gin"
)

func decodeFeedbackV2Payload(raw []byte, input any) error {
	if len(raw) > service.FeedbackMaxPayloadBytes {
		return service.ErrFeedbackRequestLimit
	}
	if !utf8.Valid(raw) {
		return service.FeedbackValidationError("留言请求必须是有效的 UTF-8 文本")
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(input); err != nil {
		return service.FeedbackValidationError("留言请求参数错误")
	}
	if err := decoder.Decode(&struct{}{}); err != io.EOF {
		return service.FeedbackValidationError("留言请求参数错误")
	}
	return nil
}

// Payload and files are streamed under independent limits. Upload names and
// declared MIME are intentionally ignored by the image validation boundary.
func (a *App) bindFeedbackV2(c *gin.Context, input any) (*service.FeedbackImageAttempt, error) {
	mediaType, params, err := mime.ParseMediaType(c.GetHeader("Content-Type"))
	if err != nil {
		return nil, service.FeedbackValidationError("请求类型无效")
	}
	if mediaType == "application/json" {
		raw, err := io.ReadAll(io.LimitReader(c.Request.Body, service.FeedbackMaxPayloadBytes+1))
		if err != nil {
			return nil, service.FeedbackValidationError("留言请求无法读取")
		}
		return nil, decodeFeedbackV2Payload(raw, input)
	}
	if mediaType != "multipart/form-data" || params["boundary"] == "" {
		return nil, service.FeedbackValidationError("请使用 JSON 或 multipart/form-data 发送留言")
	}
	if c.Request.ContentLength > service.FeedbackMaxMultipartBytes {
		return nil, service.ErrFeedbackRequestLimit
	}
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, service.FeedbackMaxMultipartBytes)
	reader := multipart.NewReader(c.Request.Body, params["boundary"])
	var attempt *service.FeedbackImageAttempt
	var payload []byte
	payloadSeen := false
	fail := func(err error) (*service.FeedbackImageAttempt, error) {
		attempt.Close()
		var maxBytes *http.MaxBytesError
		if errors.As(err, &maxBytes) {
			err = service.ErrFeedbackRequestLimit
		} else {
			var validation service.FeedbackValidationError
			if !errors.As(err, &validation) && !errors.Is(err, service.ErrFeedbackImageLimit) && !errors.Is(err, service.ErrFeedbackRequestLimit) && !errors.Is(err, service.ErrFeedbackImageFormat) && !errors.Is(err, service.ErrFeedbackImageStore) {
				err = service.FeedbackValidationError("留言请求无法读取或 multipart 结构错误")
			}
		}
		return nil, err
	}
	for {
		part, err := reader.NextPart()
		if err == io.EOF {
			break
		}
		if err != nil {
			return fail(err)
		}
		switch part.FormName() {
		case "payload":
			if payloadSeen || part.FileName() != "" {
				part.Close()
				return fail(service.FeedbackValidationError("请求必须包含一个 payload 参数"))
			}
			payloadSeen = true
			payload, err = io.ReadAll(io.LimitReader(part, service.FeedbackMaxPayloadBytes+1))
			if err == nil && len(payload) > service.FeedbackMaxPayloadBytes {
				err = service.ErrFeedbackRequestLimit
			}
		case "images":
			if part.FileName() == "" {
				part.Close()
				return fail(service.FeedbackValidationError("images 必须是图片文件"))
			}
			if attempt == nil {
				attempt, err = a.FeedbackImages.Begin(c.Request.Context())
			}
			if err == nil {
				err = attempt.AddImage(c.Request.Context(), part)
			}
		default:
			err = service.FeedbackValidationError("留言请求包含未知字段")
		}
		if err != nil {
			return fail(err)
		}
		if err := part.Close(); err != nil {
			return fail(err)
		}
	}
	// Count any epilogue toward the whole-request bound as well.
	if _, err := io.Copy(io.Discard, c.Request.Body); err != nil {
		return fail(err)
	}
	if !payloadSeen {
		return fail(service.FeedbackValidationError("请求必须包含一个 payload 参数"))
	}
	if err := decodeFeedbackV2Payload(payload, input); err != nil {
		return fail(err)
	}
	return attempt, nil
}

func feedbackV2WriteContext(c *gin.Context) context.CancelFunc {
	ctx, cancel := context.WithTimeout(c.Request.Context(), 2*time.Minute)
	c.Request = c.Request.WithContext(ctx)
	// A context alone cannot interrupt a slow network body reader. Setting the
	// HTTP read deadline bounds staging lifetime; test recorders may not support it.
	response := http.NewResponseController(c.Writer)
	_ = response.SetReadDeadline(time.Now().Add(2 * time.Minute))
	return func() { cancel(); _ = response.SetReadDeadline(time.Time{}) }
}

func feedbackAnchor(c *gin.Context) (int64, bool) {
	value := c.Query("anchor_reply_id")
	if value == "" {
		return 0, true
	}
	id, err := strconv.ParseInt(value, 10, 64)
	if err != nil || id <= 0 {
		common.BadRequest(c, "回复定位编号无效")
		return 0, false
	}
	return id, true
}

func (a *App) ListFeedbackV2(c *gin.Context) {
	page, err := service.ListFeedbackV2(a.DB.WithContext(c.Request.Context()), nil, "public", feedbackFilters(c, false))
	if err != nil {
		feedbackError(c, err, "读取留言列表失败")
		return
	}
	common.Ok(c, page)
}

func (a *App) MyFeedbackV2(c *gin.Context) {
	view := c.DefaultQuery("view", "mine")
	if view != "mine" && view != "participated" {
		common.BadRequest(c, "留言视图无效")
		return
	}
	page, err := service.ListFeedbackV2(a.DB.WithContext(c.Request.Context()), middleware.CurrentUser(c), view, feedbackFilters(c, false))
	if err != nil {
		feedbackError(c, err, "读取我的留言失败")
		return
	}
	common.Ok(c, page)
}

func (a *App) FeedbackDetailV2(c *gin.Context) {
	id, ok := feedbackID(c)
	if !ok {
		return
	}
	anchor, ok := feedbackAnchor(c)
	if !ok {
		return
	}
	page, size := feedbackPageParams(c)
	detail, err := service.GetFeedbackDetailV2(a.DB.WithContext(c.Request.Context()), id, middleware.CurrentUser(c), page, size, anchor)
	if err != nil {
		feedbackError(c, err, "读取留言失败")
		return
	}
	common.Ok(c, detail)
}

func (a *App) CreateFeedbackV2(c *gin.Context) {
	defer feedbackV2WriteContext(c)()
	var input service.CreateFeedbackV2Input
	attempt, err := a.bindFeedbackV2(c, &input)
	if err != nil {
		feedbackError(c, err, "读取留言请求失败")
		return
	}
	defer attempt.Close()
	item, err := service.CreateFeedbackV2(a.DB.WithContext(c.Request.Context()), middleware.CurrentUser(c), input, attempt)
	if err != nil {
		feedbackError(c, err, "发布留言失败")
		return
	}
	common.Ok(c, item)
}

func (a *App) ReplyFeedbackV2(c *gin.Context)      { a.replyFeedbackV2(c, false) }
func (a *App) AdminReplyFeedbackV2(c *gin.Context) { a.replyFeedbackV2(c, true) }
func (a *App) replyFeedbackV2(c *gin.Context, admin bool) {
	defer feedbackV2WriteContext(c)()
	id, ok := feedbackID(c)
	if !ok {
		return
	}
	var input service.ReplyFeedbackV2Input
	attempt, err := a.bindFeedbackV2(c, &input)
	if err != nil {
		feedbackError(c, err, "读取回复请求失败")
		return
	}
	defer attempt.Close()
	reply, err := service.AppendFeedbackReplyV2(a.DB.WithContext(c.Request.Context()), id, middleware.CurrentUser(c), input, attempt, admin, c.ClientIP())
	if err != nil {
		feedbackError(c, err, "发送回复失败")
		return
	}
	common.Ok(c, reply)
}

func (a *App) AdminListFeedbackV2(c *gin.Context) {
	page, err := service.ListAdminFeedbackV2(a.DB.WithContext(c.Request.Context()), middleware.CurrentUser(c), feedbackFilters(c, true))
	if err != nil {
		feedbackError(c, err, "读取留言列表失败")
		return
	}
	common.Ok(c, page)
}

func (a *App) AdminFeedbackDetailV2(c *gin.Context) {
	id, ok := feedbackID(c)
	if !ok {
		return
	}
	anchor, ok := feedbackAnchor(c)
	if !ok {
		return
	}
	page, size := feedbackPageParams(c)
	detail, err := service.GetAdminFeedbackDetailV2(a.DB.WithContext(c.Request.Context()), id, middleware.CurrentUser(c), page, size, anchor)
	if err != nil {
		feedbackError(c, err, "读取留言失败")
		return
	}
	common.Ok(c, detail)
}

func (a *App) AdminModerateFeedbackReplyV2(c *gin.Context) {
	id, ok := feedbackID(c)
	if !ok {
		return
	}
	replyID, err := strconv.ParseInt(c.Param("reply_id"), 10, 64)
	if err != nil || replyID <= 0 {
		common.BadRequest(c, "回复编号无效")
		return
	}
	var input struct {
		IsHidden *bool `json:"is_hidden"`
	}
	if !bindFeedbackBody(c, &input) {
		return
	}
	if input.IsHidden == nil {
		common.BadRequest(c, "请明确指定是否隐藏回复")
		return
	}
	reply, err := service.ModerateFeedbackReplyV2(a.DB.WithContext(c.Request.Context()), id, replyID, middleware.CurrentUser(c), *input.IsHidden, c.ClientIP())
	if err != nil {
		feedbackError(c, err, "更新回复显示状态失败")
		return
	}
	common.Ok(c, reply)
}

func (a *App) AdminUpdateFeedbackStatusV2(c *gin.Context) { a.changeFeedbackRootV2(c, false) }
func (a *App) AdminModerateFeedbackV2(c *gin.Context)     { a.changeFeedbackRootV2(c, true) }
func (a *App) changeFeedbackRootV2(c *gin.Context, moderation bool) {
	id, ok := feedbackID(c)
	if !ok {
		return
	}
	db, admin := a.DB.WithContext(c.Request.Context()), middleware.CurrentUser(c)
	var change *service.FeedbackChange
	var err error
	if moderation {
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
		change, err = service.UpdateFeedbackModeration(db, id, admin, *input.IsHidden)
	} else {
		var input struct {
			Status string `json:"status"`
		}
		if !bindFeedbackBody(c, &input) {
			return
		}
		change, err = service.UpdateFeedbackStatus(db, id, admin, input.Status)
	}
	if err != nil {
		feedbackError(c, err, "更新留言失败")
		return
	}
	if change.Changed {
		action := service.AuditUpdateFeedbackStatus
		diff := service.AuditDiff{Before: gin.H{"status": change.PreviousStatus}, After: gin.H{"status": change.Item.Status}}
		if moderation {
			action = service.AuditHideFeedback
			if !change.Item.IsHidden {
				action = service.AuditRestoreFeedback
			}
			diff = service.AuditDiff{Before: gin.H{"is_hidden": change.PreviousHidden}, After: gin.H{"is_hidden": change.Item.IsHidden}}
		}
		a.audit(c, action, service.AuditTargetFeedback, id, diff)
	}
	detail, err := service.GetAdminFeedbackDetailV2(db, id, admin, 1, 1, 0)
	if err != nil {
		feedbackError(c, err, "读取更新后的留言失败")
		return
	}
	common.Ok(c, detail.Message)
}

func (a *App) FeedbackImageV2(c *gin.Context) {
	variant := c.Param("variant")
	if variant != "original" && variant != "thumbnail" {
		feedbackError(c, service.ErrFeedbackNotFound, "图片不存在")
		return
	}
	row, err := service.AuthorizeFeedbackImage(a.DB.WithContext(c.Request.Context()), c.Param("image_id"), middleware.CurrentUser(c))
	if err != nil {
		feedbackError(c, err, "读取图片失败")
		return
	}
	f, contentType, size, err := a.FeedbackImages.OpenImage(*row, variant)
	if err != nil {
		feedbackError(c, err, "读取图片失败")
		return
	}
	defer f.Close()
	c.Header("X-Content-Type-Options", "nosniff")
	c.Header("Content-Type", contentType)
	c.Header("Content-Disposition", `inline; filename="`+row.ID+`"`)
	c.Header("Content-Length", strconv.FormatInt(size, 10))
	// No ETag/Last-Modified or conditional 304: every original/thumbnail request
	// reauthorizes, including HEAD, Range and stale browser conditional headers.
	c.Status(http.StatusOK)
	if c.Request.Method != http.MethodHead {
		_, _ = io.Copy(c.Writer, f)
	}
}
