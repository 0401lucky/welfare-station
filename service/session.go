package service

import (
	"errors"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/golang-jwt/jwt/v5"
)

const (
	SessionCookieName = "welfare_session"
	sessionTTL        = 30 * 24 * time.Hour
)

// Claims is the JWT payload embedded in the session cookie.
//
// 只放用户 id,不放 is_admin:管理员身份一律由 RequireAdmin 查库判定,白名单变更
// 立即生效。旧版 token 多出的 is_admin 字段会被 ParseWithClaims 忽略,继续可用。
type Claims struct {
	UserID int64 `json:"uid"`
	jwt.RegisteredClaims
}

// SessionManager signs and verifies HS256 JWTs with the configured secret.
type SessionManager struct {
	secret []byte
	secure bool
}

func NewSessionManager(secret string, secure bool) *SessionManager {
	return &SessionManager{secret: []byte(secret), secure: secure}
}

func (m *SessionManager) Sign(userID int64) (string, error) {
	now := time.Now()
	claims := Claims{
		UserID: userID,
		RegisteredClaims: jwt.RegisteredClaims{
			IssuedAt:  jwt.NewNumericDate(now),
			ExpiresAt: jwt.NewNumericDate(now.Add(sessionTTL)),
		},
	}
	tok := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	return tok.SignedString(m.secret)
}

func (m *SessionManager) Parse(token string) (*Claims, error) {
	var claims Claims
	tok, err := jwt.ParseWithClaims(token, &claims, func(t *jwt.Token) (any, error) {
		if _, ok := t.Method.(*jwt.SigningMethodHMAC); !ok {
			return nil, errors.New("unexpected signing method")
		}
		return m.secret, nil
	})
	if err != nil {
		return nil, err
	}
	if !tok.Valid {
		return nil, errors.New("invalid token")
	}
	return &claims, nil
}

// SetCookie writes the httpOnly session cookie.
func (m *SessionManager) SetCookie(c *gin.Context, token string) {
	c.SetSameSite(http.SameSiteLaxMode)
	c.SetCookie(SessionCookieName, token, int(sessionTTL.Seconds()), "/", "", m.secure, true)
}

// ClearCookie removes the session cookie.
func (m *SessionManager) ClearCookie(c *gin.Context) {
	c.SetSameSite(http.SameSiteLaxMode)
	c.SetCookie(SessionCookieName, "", -1, "/", "", m.secure, true)
}
