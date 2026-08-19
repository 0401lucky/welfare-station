package main

import (
	"context"
	"embed"
	"errors"
	"io/fs"
	"log"
	"net/http"
	"os/signal"
	"sync"
	"syscall"
	"time"

	"welfare/config"
	"welfare/model"
	"welfare/router"
	"welfare/service"

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

	// 容器重启是常态:收到 SIGINT/SIGTERM 后先停后台重试(等当前这条补发跑完),
	// 再关 HTTP 服务,避免重试执行到一半被硬砍留下状态不明的流水。
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	var workers sync.WaitGroup
	if cfg.AutoRetryEnabled {
		grants := service.NewGrantService(db, service.NewNewAPIClient(cfg.NewAPIBaseURL, cfg.NewAPIAdminPAT))
		worker := service.NewRetryWorker(db, grants, cfg.AutoRetryInterval, cfg.AutoRetryMaxAttempts)
		workers.Add(1)
		go func() {
			defer workers.Done()
			worker.Run(ctx)
		}()
	} else {
		log.Println("失败发放自动重试已关闭(AUTO_RETRY_ENABLED=false),失败流水需在后台手动重试")
	}

	addr := ":" + cfg.Port
	srv := &http.Server{Addr: addr, Handler: r}
	go func() {
		log.Printf("welfare station listening on %s", addr)
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Fatalf("server exited: %v", err)
		}
	}()

	<-ctx.Done()
	stop() // 恢复默认信号行为:再按一次 Ctrl-C 可立即结束
	log.Println("收到退出信号,正在停止后台任务...")
	workers.Wait()

	shutdownCtx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	if err := srv.Shutdown(shutdownCtx); err != nil {
		log.Printf("HTTP 服务关闭超时: %v", err)
	}
	log.Println("已退出")
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
