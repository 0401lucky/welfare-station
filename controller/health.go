package controller

import (
	"context"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
)

// GET /healthz — 存活探针。
//
// 不走 common.Ok 信封:Docker HEALTHCHECK 与隧道侧探测只看状态码,信封里的
// success 字段对它们没有意义。路由挂在根路径而非 /api 组,因此不经过限流,
// 也不会被 SPA 兜底吞掉。
func (a *App) Health(c *gin.Context) {
	ctx, cancel := context.WithTimeout(c.Request.Context(), 2*time.Second)
	defer cancel()

	sqlDB, err := a.DB.DB()
	if err == nil {
		err = sqlDB.PingContext(ctx)
	}
	if err != nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"status": "db_unreachable"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"status": "ok"})
}
