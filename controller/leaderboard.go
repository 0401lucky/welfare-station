package controller

import (
	"time"

	"welfare/common"
	"welfare/middleware"
	"welfare/service"

	"github.com/gin-gonic/gin"
)

// GET /api/leaderboard?kind=streak|game — 好运榜,匿名可看;登录用户额外带自己的名次。
func (a *App) Leaderboard(c *gin.Context) {
	kind := c.DefaultQuery("kind", service.LeaderboardKindStreak)
	if !service.IsLeaderboardKind(kind) {
		common.BadRequest(c, "kind 只能为 streak 或 game")
		return
	}
	view, err := service.Leaderboard(a.DB, kind, a.checkinTimezone(), time.Now(), middleware.CurrentUser(c))
	if err != nil {
		common.InternalError(c, "读取排行榜失败")
		return
	}
	common.Ok(c, view)
}
