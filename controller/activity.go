package controller

import (
	"errors"
	"io"
	"net/http"
	"strconv"
	"time"

	"welfare/common"
	"welfare/middleware"
	"welfare/service"

	"github.com/gin-gonic/gin"
	"gorm.io/gorm"
)

// GET /api/activities — public activity list (R3.4, visible to anonymous).
func (a *App) ListActivities(c *gin.Context) {
	list, err := service.ListPublicActivities(a.DB, time.Now(), middleware.CurrentUser(c))
	if err != nil {
		common.InternalError(c, "读取活动列表失败")
		return
	}
	common.Ok(c, list)
}

// POST /api/activities/:id/claim — claim an activity (R3.2 / R3.3).
func (a *App) ClaimActivity(c *gin.Context) {
	user := middleware.CurrentUser(c)
	if user == nil {
		common.Unauthorized(c, "请先登录")
		return
	}
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		common.BadRequest(c, "无效的活动 ID")
		return
	}

	grants := service.NewGrantService(a.DB, a.NewAPI)
	var body struct {
		ExpectedSeq int `json:"expected_seq"`
	}
	if err := c.ShouldBindJSON(&body); err != nil && !errors.Is(err, io.EOF) {
		common.BadRequest(c, "JSON 格式错误")
		return
	}
	res, err := service.DoClaim(a.DB, grants, a.NewAPI, user, id, time.Now(), body.ExpectedSeq)
	if err != nil {
		switch {
		case errors.Is(err, service.ErrNotBound):
			common.Fail(c, http.StatusForbidden, err.Error())
		case errors.Is(err, service.ErrActivityNotFound):
			common.Fail(c, http.StatusNotFound, err.Error())
		case errors.Is(err, service.ErrActivityNotStart):
			common.Fail(c, http.StatusBadRequest, err.Error())
		case errors.Is(err, service.ErrActivityEnded):
			common.Fail(c, http.StatusBadRequest, err.Error())
		case errors.Is(err, service.ErrActivitySoldOut), errors.Is(err, service.ErrClaimLimit):
			common.Fail(c, http.StatusBadRequest, err.Error())
		case errors.Is(err, service.ErrTrustLevelLow):
			common.Fail(c, http.StatusForbidden, err.Error())
		default:
			common.Fail(c, http.StatusBadRequest, err.Error())
		}
		return
	}

	data := gin.H{
		"claim_id":     res.Claim.ID,
		"replayed":     res.Replayed,
		"grant_status": res.Grant.Status,
		"quota":        res.Claim.Quota,
		"seq":          res.Claim.Seq,
	}
	if res.Grant.Status != service.GrantStatusSuccess {
		common.FailData(c, http.StatusOK, "领取成功,但额度发放遇到问题,站长会尽快补发", data)
		return
	}
	common.Ok(c, data)
}

func (a *App) RedPacketDetail(c *gin.Context) {
	user := middleware.CurrentUser(c)
	if user == nil {
		common.Unauthorized(c, "请先登录")
		return
	}
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil || id <= 0 {
		common.BadRequest(c, "无效的活动 ID")
		return
	}
	page, size := 1, 20
	if raw := c.Query("page"); raw != "" {
		page, err = strconv.Atoi(raw)
		if err != nil || page < 1 || page > 1000000 {
			common.BadRequest(c, "无效的页码")
			return
		}
	}
	if raw := c.Query("page_size"); raw != "" {
		size, err = strconv.Atoi(raw)
		if err != nil || size < 1 {
			common.BadRequest(c, "无效的分页大小")
			return
		}
	}
	result, err := service.GetPacketDetail(a.DB, id, user.ID, page, size, time.Now())
	if errors.Is(err, service.ErrPacketParticipant) {
		common.Fail(c, http.StatusForbidden, err.Error())
		return
	}
	if errors.Is(err, gorm.ErrRecordNotFound) || errors.Is(err, service.ErrActivityNotFound) {
		common.Fail(c, http.StatusNotFound, "红包不存在")
		return
	}
	if err != nil {
		common.InternalError(c, "读取红包明细失败")
		return
	}
	common.Ok(c, result)
}
