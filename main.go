package main

import (
	"embed"
	"io/fs"
	"log"
	"net/http"

	"welfare/config"
	"welfare/model"
	"welfare/router"

	"github.com/gin-gonic/gin"
)

//go:embed web/dist
var distFS embed.FS

func main() {
	cfg, err := config.Get()
	if err != nil {
		log.Fatalf("config error: %v", err)
	}

	// Connect to the database (MySQL in production, sqlite for local dev) and migrate.
	db, err := model.Open(cfg.DBDriver, cfg.DBDSN)
	if err != nil {
		log.Fatalf("database error: %v", err)
	}
	if err := model.Migrate(db); err != nil {
		log.Fatalf("migrate error: %v", err)
	}

	gin.SetMode(gin.ReleaseMode)
	r := gin.New()
	r.Use(gin.Logger(), gin.Recovery())

	router.Register(r, cfg, db)

	// Serve the frontend SPA from web/dist when it has been built. If the build
	// output is absent (fresh checkout, or dev mode), only the /api routes are
	// served so the backend still boots for development.
	registerFrontend(r)

	addr := ":" + cfg.Port
	log.Printf("welfare station listening on %s", addr)
	if err := r.Run(addr); err != nil {
		log.Fatalf("server exited: %v", err)
	}
}

func registerFrontend(r *gin.Engine) {
	sub, err := fs.Sub(distFS, "web/dist")
	if err != nil {
		// web/dist missing: keep API-only server.
		log.Println("web/dist not built, serving API only")
		return
	}
	index, err := sub.Open("index.html")
	if err != nil {
		log.Println("web/dist/index.html not found, serving API only")
		return
	}
	index.Close()

	fileServer := http.FileServer(http.FS(sub))
	r.NoRoute(func(c *gin.Context) {
		if len(c.Request.URL.Path) >= 4 && c.Request.URL.Path[:4] == "/api" {
			c.JSON(http.StatusNotFound, gin.H{"success": false, "message": "not found", "data": nil})
			return
		}
		// SPA fallback: serve index.html for client-side routes.
		c.Request.URL.Path = "/"
		fileServer.ServeHTTP(c.Writer, c.Request)
	})
	r.GET("/assets/*filepath", func(c *gin.Context) {
		fileServer.ServeHTTP(c.Writer, c.Request)
	})
	r.GET("/favicon.svg", func(c *gin.Context) {
		fileServer.ServeHTTP(c.Writer, c.Request)
	})
}
