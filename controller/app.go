package controller

import (
	"strings"

	"welfare/config"
	"welfare/middleware"
	"welfare/service"

	"gorm.io/gorm"
)

// App bundles the dependencies every controller needs.
type App struct {
	DB       *gorm.DB
	Config   *config.Config
	Sessions *service.SessionManager
	NewAPI   *service.NewAPIClient
	OAuth    *service.LinuxDOClient
	Auth     *middleware.AuthMiddleware
}

// NewApp constructs the controller bundle wired in router.Register.
func NewApp(db *gorm.DB, cfg *config.Config) *App {
	// Secure cookies only off the wire when the site is served over HTTPS
	// (design.md §9 requires Secure; local http dev needs it disabled).
	secure := strings.HasPrefix(cfg.WelfareBaseURL, "https://")
	sessions := service.NewSessionManager(cfg.WelfareJWTSecret, secure)
	newapi := service.NewNewAPIClient(cfg.NewAPIBaseURL, cfg.NewAPIAdminPAT)
	oauth := service.NewLinuxDOClient(cfg.LinuxDOClientID, cfg.LinuxDOClientSec, cfg.WelfareBaseURL)
	auth := middleware.NewAuthMiddleware(sessions, db)
	return &App{DB: db, Config: cfg, Sessions: sessions, NewAPI: newapi, OAuth: oauth, Auth: auth}
}
