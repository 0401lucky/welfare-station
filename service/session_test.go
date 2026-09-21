package service

import (
	"encoding/base64"
	"strings"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

const testSessionSecret = "test-secret-test-secret-test-secret-1234"

// TestSessionSignOmitsIsAdmin 验证新签发的 token 不再携带 is_admin,
// 管理员身份只以数据库为准。
func TestSessionSignOmitsIsAdmin(t *testing.T) {
	m := NewSessionManager(testSessionSecret, false)
	tok, err := m.Sign(7)
	if err != nil {
		t.Fatalf("sign: %v", err)
	}
	parts := strings.Split(tok, ".")
	if len(parts) != 3 {
		t.Fatalf("token 段数 = %d", len(parts))
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		t.Fatalf("decode payload: %v", err)
	}
	if strings.Contains(string(payload), "is_admin") {
		t.Fatalf("payload 不应包含 is_admin: %s", payload)
	}

	claims, err := m.Parse(tok)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if claims.UserID != 7 {
		t.Fatalf("uid = %d, want 7", claims.UserID)
	}
}

// TestSessionParseAcceptsLegacyIsAdminClaim 验证旧版含 is_admin 的 token 仍可解析:
// 去掉字段属于向前兼容变更,已登录用户不应被强制下线。
func TestSessionParseAcceptsLegacyIsAdminClaim(t *testing.T) {
	type legacyClaims struct {
		UserID  int64 `json:"uid"`
		IsAdmin bool  `json:"is_admin"`
		jwt.RegisteredClaims
	}
	now := time.Now()
	legacy := jwt.NewWithClaims(jwt.SigningMethodHS256, legacyClaims{
		UserID:  9,
		IsAdmin: true,
		RegisteredClaims: jwt.RegisteredClaims{
			IssuedAt:  jwt.NewNumericDate(now),
			ExpiresAt: jwt.NewNumericDate(now.Add(time.Hour)),
		},
	})
	tok, err := legacy.SignedString([]byte(testSessionSecret))
	if err != nil {
		t.Fatalf("sign legacy: %v", err)
	}

	m := NewSessionManager(testSessionSecret, false)
	claims, err := m.Parse(tok)
	if err != nil {
		t.Fatalf("旧 token 应可解析: %v", err)
	}
	if claims.UserID != 9 {
		t.Fatalf("uid = %d, want 9", claims.UserID)
	}
}
