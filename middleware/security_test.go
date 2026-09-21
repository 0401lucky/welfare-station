package middleware

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
)

func securityHeadersOf(t *testing.T, httpsMode bool) http.Header {
	t.Helper()
	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.Use(SecurityHeaders(httpsMode))
	r.GET("/ping", func(c *gin.Context) { c.String(http.StatusOK, "pong") })

	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/ping", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("code = %d", rec.Code)
	}
	return rec.Header()
}

// TestSecurityHeadersFixedSet 验证固定安全头始终存在,且 CSP 只以 Report-Only 下发。
func TestSecurityHeadersFixedSet(t *testing.T) {
	h := securityHeadersOf(t, false)
	want := map[string]string{
		"X-Content-Type-Options": "nosniff",
		"X-Frame-Options":        "SAMEORIGIN",
		"Referrer-Policy":        "strict-origin-when-cross-origin",
		"Permissions-Policy":     "camera=(), microphone=(), geolocation=()",
	}
	for k, v := range want {
		if got := h.Get(k); got != v {
			t.Errorf("%s = %q, want %q", k, got, v)
		}
	}
	csp := h.Get("Content-Security-Policy-Report-Only")
	for _, directive := range []string{
		"default-src 'self'",
		"img-src 'self' data: https:",
		"style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
		"font-src 'self' data: https://fonts.gstatic.com",
		"frame-ancestors 'self'",
	} {
		if !strings.Contains(csp, directive) {
			t.Errorf("CSP 缺少 %q: %s", directive, csp)
		}
	}
	if h.Get("Content-Security-Policy") != "" {
		t.Error("CSP 不应以强制模式下发")
	}
}

// TestSecurityHeadersHSTSOnlyOverHTTPS 验证 HSTS 仅在 https 模式下发。
func TestSecurityHeadersHSTSOnlyOverHTTPS(t *testing.T) {
	if got := securityHeadersOf(t, false).Get("Strict-Transport-Security"); got != "" {
		t.Errorf("http 模式不应下发 HSTS, got %q", got)
	}
	if got := securityHeadersOf(t, true).Get("Strict-Transport-Security"); got != "max-age=31536000; includeSubDomains" {
		t.Errorf("https 模式 HSTS = %q", got)
	}
}
