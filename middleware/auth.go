package middleware

import (
	"errors"
	"net/http"

	"welfare/common"
	"welfare/model"
	"welfare/service"

	"github.com/gin-gonic/gin"
	"gorm.io/gorm"
)

const ContextUserKey = "auth_user"

// AuthMiddleware holds the dependencies needed by user/admin guards.
type AuthMiddleware struct {
	sessions *service.SessionManager
	db       *gorm.DB
}

func NewAuthMiddleware(sessions *service.SessionManager, db *gorm.DB) *AuthMiddleware {
	return &AuthMiddleware{sessions: sessions, db: db}
}

// loadUser parses the session cookie and loads the user from the database,
// rejecting invalid sessions and banned users.
func (m *AuthMiddleware) loadUser(c *gin.Context) (*model.User, error) {
	token, err := c.Cookie(service.SessionCookieName)
	if err != nil || token == "" {
		return nil, errors.New("未登录")
	}
	claims, err := m.sessions.Parse(token)
	if err != nil {
		return nil, errors.New("会话无效")
	}
	var user model.User
	if err := m.db.First(&user, claims.UserID).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, errors.New("用户不存在")
		}
		return nil, err
	}
	if user.Status != 1 {
		return nil, errors.New("账号已被禁用")
	}
	return &user, nil
}

// RequireUser guards user-scoped routes.
func (m *AuthMiddleware) RequireUser() gin.HandlerFunc {
	return func(c *gin.Context) {
		user, err := m.loadUser(c)
		if err != nil {
			common.Fail(c, http.StatusUnauthorized, err.Error())
			c.Abort()
			return
		}
		c.Set(ContextUserKey, user)
		c.Next()
	}
}

// RequireAdmin guards admin routes. Admin identity is double-checked against
// the database (not just the JWT claim) so whitelist changes take effect
// immediately (design.md §9).
func (m *AuthMiddleware) RequireAdmin() gin.HandlerFunc {
	return func(c *gin.Context) {
		user, err := m.loadUser(c)
		if err != nil {
			common.Fail(c, http.StatusUnauthorized, err.Error())
			c.Abort()
			return
		}
		if !user.IsAdmin {
			common.Fail(c, http.StatusForbidden, "需要管理员权限")
			c.Abort()
			return
		}
		c.Set(ContextUserKey, user)
		c.Next()
	}
}

// CurrentUser retrieves the authenticated user set by RequireUser/RequireAdmin.
func CurrentUser(c *gin.Context) *model.User {
	if v, ok := c.Get(ContextUserKey); ok {
		if u, ok := v.(*model.User); ok {
			return u
		}
	}
	return nil
}
