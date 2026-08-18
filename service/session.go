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
type Claims struct {
	UserID  int64 `json:"uid"`
	IsAdmin bool  `json:"is_admin"`
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

func (m *SessionManager) Sign(userID int64, isAdmin bool) (string, error) {
	now := time.Now()
	claims := Claims{
		UserID:  userID,
		IsAdmin: isAdmin,
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
