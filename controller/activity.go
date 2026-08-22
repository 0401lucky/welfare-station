package controller

import (
	"errors"
	"net/http"
	"strconv"
	"time"

	"welfare/common"
	"welfare/middleware"
	"welfare/service"

	"github.com/gin-gonic/gin"
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
	res, err := service.DoClaim(a.DB, grants, a.NewAPI, user, id, time.Now())
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
		"quota": res.Claim.Quota,
		"seq":   res.Claim.Seq,
	}
	if res.OutErr != nil {
		data["grant_status"] = service.GrantStatusFailed
		common.FailData(c, http.StatusOK, "领取成功,但额度发放遇到问题,站长会尽快补发", data)
		return
	}
	data["grant_status"] = service.GrantStatusSuccess
	common.Ok(c, data)
}
