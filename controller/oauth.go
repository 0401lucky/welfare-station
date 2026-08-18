package controller

import (
	"crypto/rand"
	"encoding/hex"
	"log"
	"net/http"
	"os"
	"strconv"

	"welfare/common"
	"welfare/middleware"
	"welfare/service"

	"github.com/gin-gonic/gin"
)

// GET /api/oauth/linuxdo — begin the LinuxDO OAuth flow.
func (a *App) OAuthLogin(c *gin.Context) {
	state := randomHex(16)
	service.PutOAuthState(state)
	redirect := a.OAuth.AuthorizeURL(state)
	// MOCK_OAUTH (dev only): the authorize step self-redirects to the local
	// callback so the whole flow can be exercised without connect.linux.do.
	// A mock_id query param (dev helper to pick a specific LinuxDO id) is
	// preserved through the redirect.
	if a.Config.MockOAuth {
		redirect = a.Config.WelfareBaseURL + "/api/oauth/linuxdo/callback?code=mock&state=" + state
		if mid := c.Query("mock_id"); mid != "" {
			redirect += "&mock_id=" + mid
		}
	}
	c.Redirect(http.StatusFound, redirect)
}

// GET /api/oauth/linuxdo/callback — complete the OAuth flow and sign the user in.
func (a *App) OAuthCallback(c *gin.Context) {
	code := c.Query("code")
	state := c.Query("state")
	if code == "" || state == "" {
		common.BadRequest(c, "缺少 code 或 state 参数")
		return
	}
	if !service.ConsumeOAuthState(state) {
		common.BadRequest(c, "state 无效或已过期")
		return
	}

	ou, err := a.resolveOAuthUser(code, c.Query("mock_id"))
	if err != nil {
		log.Printf("oauth: resolve user failed: %v", err)
		common.InternalError(c, "OAuth 授权失败")
		return
	}
	if ou.Silenced || !ou.Active {
		common.Forbidden(c, "该 LinuxDO 账号已被静音或停用，无法登录")
		return
	}

	isAdmin := a.Config.IsAdminLinuxDO(strconv.Itoa(ou.ID))
	user, err := service.UpsertUserFromOAuth(a.DB, ou, isAdmin)
	if err != nil {
		log.Printf("oauth: upsert user failed: %v", err)
		common.InternalError(c, "登录失败")
		return
	}

	user, _, err = service.BindToNewAPI(a.DB, a.NewAPI, user)
	if err != nil {
		log.Printf("oauth: bind failed: %v", err)
		common.InternalError(c, "账号绑定失败")
		return
	}

	token, err := a.Sessions.Sign(user.ID, user.IsAdmin)
	if err != nil {
		log.Printf("oauth: sign token failed: %v", err)
		common.InternalError(c, "登录失败")
		return
	}
	a.Sessions.SetCookie(c, token)
	c.Redirect(http.StatusFound, a.Config.WelfareBaseURL+"/")
}

// resolveOAuthUser performs the real code exchange + user fetch, or returns a
// mock profile when MOCK_OAUTH is enabled (development only).
func (a *App) resolveOAuthUser(code, mockID string) (*service.OAuthUser, error) {
	if a.Config.MockOAuth && code == "mock" {
		id := atoiDefault(mockID, atoiDefault(os.Getenv("MOCK_LINUXDO_ID"), 10001))
		trust := atoiDefault(os.Getenv("MOCK_TRUST_LEVEL"), 2)
		return &service.OAuthUser{
			ID:         id,
			Username:   "mock_user",
			Name:       "Mock 用户",
			Active:     true,
			TrustLevel: trust,
			Silenced:   false,
		}, nil
	}
	token, err := a.OAuth.ExchangeCode(code)
	if err != nil {
		return nil, err
	}
	return a.OAuth.FetchUser(token)
}

// POST /api/user/rebind — re-run binding detection from the bind guide page.
func (a *App) Rebind(c *gin.Context) {
	user := middleware.CurrentUser(c)
	user, bound, err := service.BindToNewAPI(a.DB, a.NewAPI, user)
	if err != nil {
		common.InternalError(c, "检测失败,请稍后重试")
		return
	}
	common.Ok(c, gin.H{
		"bound":          bound,
		"newapi_user_id": user.NewapiUserID,
	})
}

// POST /api/user/logout — clear the session cookie.
func (a *App) Logout(c *gin.Context) {
	a.Sessions.ClearCookie(c)
	common.Ok(c, gin.H{"logout": true})
}

func randomHex(n int) string {
	b := make([]byte, n)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

func atoiDefault(s string, def int) int {
	if s == "" {
		return def
	}
	v, err := strconv.Atoi(s)
	if err != nil {
		return def
	}
	return v
}
