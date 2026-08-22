package router

import (
	"welfare/common"
	"welfare/config"
	"welfare/controller"
	"welfare/middleware"

	"github.com/gin-gonic/gin"
	"gorm.io/gorm"
)

// Register wires up every route group. Milestones add their routes here as
// they land (M3 OAuth/login, M5 checkin, M6 activities, M7 admin).
func Register(r *gin.Engine, cfg *config.Config, db *gorm.DB) {
	app := controller.NewApp(db, cfg)
	api := r.Group("/api")

	// ---- Public ----
	api.GET("/site/info", func(c *gin.Context) {
		common.Ok(c, gin.H{
			"site_name":      cfg.WelfareSiteName,
			"quota_per_unit": cfg.QuotaPerUnit,
			// 只读:供前端把「单次发放上限」换算成美元提示,校验仍以后端为准
			"max_grant_quota": cfg.MaxGrantQuota,
			"newapi_url":      cfg.NewAPIPublicURL, // 为空时前端不渲染跳转入口
			"notice":          "",                  // notice is editable later via admin settings
		})
	})
	api.GET("/oauth/linuxdo", app.OAuthLogin)
	api.GET("/oauth/linuxdo/callback", middleware.RateLimitIP(), app.OAuthCallback)

	user := api.Group("", app.Auth.RequireUser())
	user.GET("/user/self", app.GetSelf)
	user.POST("/user/logout", app.Logout)
	user.POST("/user/rebind", app.Rebind)

	// ---- M5: check-in ----
	user.GET("/checkin", app.GetCheckin)
	user.POST("/checkin", middleware.RateLimitUser(), app.DoCheckin)

	// ---- M6: activities (public list + user claim) ----
	api.GET("/activities", app.Auth.OptionalUser(), app.ListActivities)
	user.POST("/activities/:id/claim", middleware.RateLimitUser(), app.ClaimActivity)

	// ---- M7: user grants (my records) ----
	user.GET("/user/grants", app.GetMyGrants)

	// ---- 小游戏:开局/存档/结算/放弃 ----
	// 用独立令牌桶,不复用 RateLimitUser —— 后者是签到与活动共享的 10 令牌桶,
	// 游戏挂上去会 ①checkpoint 被 429 ②把用户的签到额度吃光。
	user.GET("/games", app.ListGames)
	user.GET("/games/:game/status", app.GameStatus)
	user.POST("/games/:game/start", middleware.RateLimitGame(), app.GameStart)
	user.POST("/games/:game/checkpoint", middleware.RateLimitGameCheckpoint(), app.GameCheckpoint)
	user.POST("/games/:game/submit", middleware.RateLimitGame(), app.GameSubmit)
	user.POST("/games/:game/cancel", middleware.RateLimitGame(), app.GameCancel)

	// ---- M7: admin (RequireAdmin) ----
	admin := api.Group("", app.Auth.RequireAdmin())
	admin.GET("/admin/dashboard", app.AdminDashboard)
	admin.GET("/admin/checkin-config", app.AdminGetCheckinConfig)
	admin.PUT("/admin/checkin-config", app.AdminPutCheckinConfig)
	admin.GET("/admin/activities", app.AdminListActivities)
	admin.POST("/admin/activities", app.AdminCreateActivity)
	admin.GET("/admin/activities/:id/claims", app.AdminListClaims)
	admin.PUT("/admin/activities/:id", app.AdminUpdateActivity)
	admin.DELETE("/admin/activities/:id", app.AdminDeleteActivity)
	admin.GET("/admin/grants", app.AdminListGrants)
	admin.POST("/admin/grants/:id/retry", app.AdminRetryGrant)
	admin.POST("/admin/grants/manual", app.AdminManualGrant)
	admin.GET("/admin/users", app.AdminListUsers)
	admin.PUT("/admin/users/:id/status", app.AdminToggleUserStatus)
	admin.GET("/admin/game-config", app.AdminGetGameConfig)
	admin.PUT("/admin/game-config", app.AdminPutGameConfig)
	admin.GET("/admin/budgets", app.AdminBudgets)
}
