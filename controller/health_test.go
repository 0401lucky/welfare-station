package controller

import (
	"net/http"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
)

// TestHealthz 验证 DB 可达返回 200,连接关闭后返回 503。
func TestHealthz(t *testing.T) {
	app, srv, db := setupTest(t, nil)
	defer srv.Close()

	r := gin.New()
	r.GET("/healthz", app.Health)

	rec := perform(r, http.MethodGet, "/healthz", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("healthy: code = %d, body = %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), `"status":"ok"`) {
		t.Fatalf("healthy: body = %s", rec.Body.String())
	}

	// 关掉底层连接池模拟 DB 不可达。
	sqlDB, err := db.DB()
	if err != nil {
		t.Fatalf("sql db: %v", err)
	}
	if err := sqlDB.Close(); err != nil {
		t.Fatalf("close: %v", err)
	}

	rec = perform(r, http.MethodGet, "/healthz", nil)
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("unreachable: code = %d, body = %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), `"status":"db_unreachable"`) {
		t.Fatalf("unreachable: body = %s", rec.Body.String())
	}
}
