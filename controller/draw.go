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

// drawSvc 组装本次请求要用的 DrawService。发放一律走既有 GrantService。
func (a *App) drawSvc() *service.DrawService {
	return service.NewDrawService(a.DB, service.NewGrantService(a.DB, a.NewAPI))
}

// failDraw 把 service 层的错误映射成 HTTP 状态码。
func failDraw(c *gin.Context, err error) {
	switch {
	case errors.Is(err, service.ErrAlreadyDrawn),
		errors.Is(err, service.ErrDrawDisabled),
		errors.Is(err, service.ErrDrawNotBound),
		errors.Is(err, service.ErrDrawRequiresCheckin):
		common.Fail(c, http.StatusBadRequest, err.Error())
	default:
		common.InternalError(c, err.Error())
	}
}

// GET /api/draw — 今日抽奖状态:是否已抽、已抽则回结果、档位表。
func (a *App) GetDraw(c *gin.Context) {
	user := middleware.CurrentUser(c)
	if user == nil {
		common.Unauthorized(c, "未登录")
		return
	}
	cfg, err := service.GetDrawConfig(a.DB, service.MaxGrantQuotaOf(a.DB, a.Config.MaxGrantQuota))
	if err != nil {
		common.InternalError(c, "读取抽奖配置失败")
		return
	}
	view, err := a.drawSvc().GetDrawView(cfg, user, time.Now())
	if err != nil {
		common.InternalError(c, "读取抽奖数据失败")
		return
	}
	common.Ok(c, view)
}

// POST /api/draw — 抽一次(每人每天一次,限流)。
//
// 请求体是空的:幸运数字与奖励全部由服务端摇出,前端选哪片四叶草都不影响结果。
// 这是刻意的——任何让客户端参与随机的入口都等于把奖池交给前端。
func (a *App) DoDraw(c *gin.Context) {
	user := middleware.CurrentUser(c)
	if user == nil {
		common.Unauthorized(c, "未登录")
		return
	}
	cfg, err := service.GetDrawConfig(a.DB, service.MaxGrantQuotaOf(a.DB, a.Config.MaxGrantQuota))
	if err != nil {
		common.InternalError(c, "读取抽奖配置失败")
		return
	}
	// 预算池上限存在 game_config 里,与小游戏共用同一套基础设施。
	gameCfg, err := service.GetGameConfig(a.DB)
	if err != nil {
		common.InternalError(c, "读取预算配置失败")
		return
	}

	res, err := a.drawSvc().DoDraw(cfg, gameCfg, user)
	if err != nil {
		failDraw(c, err)
		return
	}

	data := gin.H{
		"roll":       res.Draw.Roll,
		"tier_label": res.Draw.TierLabel,
		"quip":       res.Tier.Quip,
		"quota":      res.Draw.Quota,
		"quota_type": res.Draw.QuotaType,
		"reason":     res.Draw.Reason,
	}
	switch {
	case res.Grant == nil:
		// 没中奖(或预算已空):没有流水,如实告诉前端本次无发放。
		data["grant_status"] = service.GameGrantNone
	case res.OutErr != nil:
		// 抽奖已记录,额度由自动重试器补发。语义与签到/游戏接口一致。
		data["grant_status"] = service.GrantStatusFailed
		common.FailData(c, http.StatusOK, "中奖已记录,但额度发放遇到问题,稍后会自动补发", data)
		return
	default:
		data["grant_status"] = service.GrantStatusSuccess
	}
	common.Ok(c, data)
}
