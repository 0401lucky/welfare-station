package controller

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"welfare/config"
	"welfare/model"
	"welfare/service"

	"github.com/gin-gonic/gin"
	"github.com/glebarez/sqlite"
	"gorm.io/gorm"
)

var testDBCounter int64

// sqliteTestDB returns a fresh, isolated in-memory SQLite DB per call.
func sqliteTestDB() *gorm.DB {
	n := atomic.AddInt64(&testDBCounter, 1)
	dsn := fmt.Sprintf("file:welfare-test-%d?mode=memory&cache=shared", n)
	db, err := gorm.Open(sqlite.Open(dsn), &gorm.Config{})
	if err != nil {
		panic(err)
	}
	return db
}

func setupTest(t *testing.T, byLinuxdo func(linuxDOID string) (map[string]any, int)) (*App, *httptest.Server, *gorm.DB) {
	t.Helper()
	gin.SetMode(gin.TestMode)

	// Mock new-api server (design.md §4: /api/user/by_linuxdo + /api/user/:id).
	mux := http.NewServeMux()
	mux.HandleFunc("/api/user/by_linuxdo", func(w http.ResponseWriter, r *http.Request) {
		id := r.URL.Query().Get("linux_do_id")
		if byLinuxdo == nil {
			writeJSON(w, http.StatusOK, map[string]any{"success": false, "message": "用户不存在"})
			return
		}
		data, code := byLinuxdo(id)
		writeJSON(w, code, map[string]any{"success": code < 300, "message": "", "data": data})
	})
	mux.HandleFunc("/api/user/", func(w http.ResponseWriter, r *http.Request) {
		seg := strings.TrimPrefix(r.URL.Path, "/api/user/")
		if seg == "" {
			writeJSON(w, http.StatusNotFound, map[string]any{"success": false, "message": "not found"})
			return
		}
		data, code := byLinuxdo("")
		if data == nil {
			writeJSON(w, http.StatusOK, map[string]any{"success": false, "message": "用户不存在"})
			return
		}
		writeJSON(w, code, map[string]any{"success": code < 300, "message": "", "data": data})
	})
	srv := httptest.NewServer(mux)

	db := sqliteTestDB()
	if err := model.Migrate(db); err != nil {
		t.Fatalf("migrate: %v", err)
	}

	cfg := &config.Config{
		WelfareBaseURL:   "http://localhost:8080",
		WelfareJWTSecret: "test-secret-test-secret-test-secret-1234",
		NewAPIBaseURL:    srv.URL,
		NewAPIAdminPAT:   "pat",
		AdminLinuxDOIDs:  map[string]bool{"90001": true},
		MockOAuth:        true,
		QuotaPerUnit:     500000,
		MaxGrantQuota:    5000000,
	}
	app := NewApp(db, cfg)
	app.Config.WelfareBaseURL = cfg.WelfareBaseURL
	return app, srv, db
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

func perform(r *gin.Engine, method, path string, cookies []*http.Cookie) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, path, nil)
	for _, ck := range cookies {
		req.AddCookie(ck)
	}
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	return rec
}

func route(app *App) *gin.Engine {
	r := gin.New()
	api := r.Group("/api")
	api.GET("/oauth/linuxdo/callback", app.OAuthCallback)
	user := api.Group("", app.Auth.RequireUser())
	user.GET("/user/self", app.GetSelf)
	user.POST("/user/rebind", app.Rebind)
	user.POST("/user/logout", app.Logout)
	return r
}

func sessionCookie(t *testing.T, app *App, userID int64, isAdmin bool) *http.Cookie {
	t.Helper()
	tok, err := app.Sessions.Sign(userID, isAdmin)
	if err != nil {
		t.Fatalf("sign: %v", err)
	}
	return &http.Cookie{Name: service.SessionCookieName, Value: tok}
}

// TestOAuthMockCallbackLogin runs the mock OAuth callback end-to-end.
func TestOAuthMockCallbackLogin(t *testing.T) {
	app, srv, _ := setupTest(t, func(linuxDOID string) (map[string]any, int) {
		if linuxDOID == "10001" {
			return map[string]any{
				"id": 42, "username": "alice", "display_name": "Alice",
				"linux_do_id": "10001", "quota": 1000, "status": 1, "role": 1,
			}, http.StatusOK
		}
		return map[string]any{"success": false, "message": "用户不存在"}, http.StatusOK
	})
	defer srv.Close()

	svcState(t, "state123")
	rec := perform(route(app), http.MethodGet, "/api/oauth/linuxdo/callback?code=mock&state=state123", nil)
	if rec.Code != http.StatusFound {
		t.Fatalf("expected redirect, got %d body=%s", rec.Code, rec.Body.String())
	}
	var cookie *http.Cookie
	for _, ck := range rec.Result().Cookies() {
		if ck.Name == service.SessionCookieName {
			cookie = ck
		}
	}
	if cookie == nil {
		t.Fatalf("expected session cookie to be set")
	}

	// Call /api/user/self with the cookie.
	rec2 := perform(route(app), http.MethodGet, "/api/user/self", []*http.Cookie{cookie})
	if rec2.Code != http.StatusOK {
		t.Fatalf("self got %d: %s", rec2.Code, rec2.Body.String())
	}
	var res struct {
		Success bool `json:"success"`
		Data    struct {
			Bound bool `json:"bound"`
			User  struct {
				NewapiUserID   *int64 `json:"newapi_user_id"`
				NewapiUsername string `json:"newapi_username"`
			} `json:"user"`
		} `json:"data"`
	}
	if err := json.Unmarshal(rec2.Body.Bytes(), &res); err != nil {
		t.Fatalf("parse self: %v", err)
	}
	if !res.Data.Bound || res.Data.User.NewapiUserID == nil || *res.Data.User.NewapiUserID != 42 || res.Data.User.NewapiUsername != "alice" {
		t.Fatalf("expected auto-bound to newapi 42, got bound=%v user=%+v", res.Data.Bound, res.Data.User)
	}
}

// TestOAuthUnauthorizedState ensures a bogus state is rejected.
func TestOAuthUnauthorizedState(t *testing.T) {
	app, srv, _ := setupTest(t, nil)
	defer srv.Close()
	rec := perform(route(app), http.MethodGet, "/api/oauth/linuxdo/callback?code=mock&state=bad", nil)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for invalid state, got %d", rec.Code)
	}
}

// TestRebindWhenNotRegistered shows the user stays unbound on 用户不存在.
func TestRebindWhenNotRegistered(t *testing.T) {
	app, srv, _ := setupTest(t, nil)
	defer srv.Close()
	db := app.DB
	db.Create(&model.User{LinuxDOID: "10001", LinuxDOName: "alice", TrustLevel: 2, Status: 1})
	var u model.User
	db.Where("linux_do_id = ?", "10001").First(&u)
	cookie := sessionCookie(t, app, u.ID, false)

	rec := perform(route(app), http.MethodPost, "/api/user/rebind", []*http.Cookie{cookie})
	if rec.Code != http.StatusOK {
		t.Fatalf("rebind got %d: %s", rec.Code, rec.Body.String())
	}
	var res struct {
		Success bool `json:"success"`
		Data    struct {
			Bound bool `json:"bound"`
		} `json:"data"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &res); err != nil {
		t.Fatalf("parse rebind: %v", err)
	}
	if res.Data.Bound {
		t.Fatalf("expected unbound when new-api has no such user")
	}
}

// TestSelfRejectedWhenUnauthenticated verifies RequireUser works.
func TestSelfRejectedWhenUnauthenticated(t *testing.T) {
	app, srv, _ := setupTest(t, nil)
	defer srv.Close()
	rec := perform(route(app), http.MethodGet, "/api/user/self", nil)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d", rec.Code)
	}
}

// TestAdminWhitelistRefresh verifies admin flag refreshes on login.
func TestAdminWhitelistRefresh(t *testing.T) {
	app, srv, _ := setupTest(t, nil)
	defer srv.Close()

	// Admin linuxdo id 90001 logs in → is_admin true.
	service.PutOAuthState("adminstate")
	rec := perform(route(app), http.MethodGet, "/api/oauth/linuxdo/callback?code=mock&state=adminstate&mock_id=90001", nil)
	if rec.Code != http.StatusFound {
		t.Fatalf("expected redirect, got %d", rec.Code)
	}
	var u model.User
	if err := app.DB.Where("linux_do_id = ?", "90001").First(&u).Error; err != nil {
		t.Fatalf("find admin user: %v", err)
	}
	if !u.IsAdmin {
		t.Fatalf("expected admin flag set for whitelisted id")
	}
}

// svcState registers a state (dev helper).
func svcState(t *testing.T, state string) {
	t.Helper()
	service.PutOAuthState(state)
}
