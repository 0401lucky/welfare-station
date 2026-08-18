package controller

import (
	"errors"
	"net/http"
	"time"

	"welfare/common"
	"welfare/middleware"
	"welfare/service"

	"github.com/gin-gonic/gin"
)

// GET /api/checkin — month calendar + streak + today status + rules summary.
func (a *App) GetCheckin(c *gin.Context) {
	user := middleware.CurrentUser(c)
	if user == nil {
		common.Unauthorized(c, "未登录")
		return
	}
	cfg, err := service.GetCheckinConfig(a.DB)
	if err != nil {
		common.InternalError(c, "读取签到配置失败")
		return
	}
	view, err := service.GetCheckinView(a.DB, cfg, user, time.Now())
	if err != nil {
		common.InternalError(c, "读取签到数据失败")
		return
	}
	common.Ok(c, view)
}

// POST /api/checkin — perform a check-in (rate limited per user).
func (a *App) DoCheckin(c *gin.Context) {
	user := middleware.CurrentUser(c)
	if user == nil {
		common.Unauthorized(c, "未登录")
		return
	}
	cfg, err := service.GetCheckinConfig(a.DB)
	if err != nil {
		common.InternalError(c, "读取签到配置失败")
		return
	}
	grants := service.NewGrantService(a.DB, a.NewAPI)
	res, err := service.DoCheckin(a.DB, grants, cfg, user)
	if err != nil {
		switch {
		case errors.Is(err, service.ErrAlreadyCheckedIn):
			common.Fail(c, http.StatusBadRequest, "今日已签到,明天再来吧")
		case errors.Is(err, service.ErrCheckinDisabled):
			common.Fail(c, http.StatusBadRequest, err.Error())
		case errors.Is(err, service.ErrTrustLevelTooLow):
			common.Fail(c, http.StatusForbidden, err.Error())
		default:
			common.InternalError(c, err.Error())
		}
		return
	}

	data := gin.H{
		"quota":  res.Checkin.Quota,
		"streak": res.Checkin.Streak,
		"bonus":  res.Bonus,
	}
	if res.OutErr != nil {
		// The check-in is recorded but the payout needs a manual retry.
		data["grant_status"] = service.GrantStatusFailed
		common.FailData(c, http.StatusOK, "签到成功,但额度发放遇到问题,站长会尽快补发", data)
		return
	}
	data["grant_status"] = service.GrantStatusSuccess
	common.Ok(c, data)
}
