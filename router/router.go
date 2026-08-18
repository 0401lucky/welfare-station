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
			"newapi_url":     cfg.NewAPIPublicURL, // 为空时前端不渲染跳转入口
			"notice":         "", // notice is editable later via admin settings
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
	api.GET("/activities", app.ListActivities)
	user.POST("/activities/:id/claim", middleware.RateLimitUser(), app.ClaimActivity)

	// ---- M7: user grants (my records) ----
	user.GET("/user/grants", app.GetMyGrants)

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
}
