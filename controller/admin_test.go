package controller

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"welfare/model"
	"welfare/service"

	"github.com/gin-gonic/gin"
)

func adminRoutes(app *App) *gin.Engine {
	r := gin.New()
	api := r.Group("/api")
	admin := api.Group("", app.Auth.RequireAdmin())
	admin.GET("/admin/dashboard", app.AdminDashboard)
	admin.GET("/admin/checkin-config", app.AdminGetCheckinConfig)
	admin.PUT("/admin/checkin-config", app.AdminPutCheckinConfig)
	admin.GET("/admin/activities", app.AdminListActivities)
	admin.POST("/admin/activities", app.AdminCreateActivity)
	admin.GET("/admin/activities/:id/claims", app.AdminListClaims)
	admin.PUT("/admin/activities/:id", app.AdminUpdateActivity)
	admin.DELETE("/admin/activities/:id", app.AdminDeleteActivity)
	admin.GET("/admin/grants", app.AdminListGrants)
	admin.POST("/admin/grants/:id/retry", app.AdminRetryGrant)
	admin.POST("/admin/grants/manual", app.AdminManualGrant)
	admin.GET("/admin/users", app.AdminListUsers)
	admin.PUT("/admin/users/:id/status", app.AdminToggleUserStatus)
	return r
}

func adminUsers(t *testing.T, app *App) (admin, normal model.User) {
	t.Helper()
	admin = model.User{LinuxDOID: "90001", LinuxDOName: "boss", TrustLevel: 4, Status: 1, IsAdmin: true, NewapiUserID: int64p(900), NewapiUsername: "boss"}
	normal = model.User{LinuxDOID: "10001", LinuxDOName: "alice", TrustLevel: 2, Status: 1, IsAdmin: false, NewapiUserID: int64p(42), NewapiUsername: "alice"}
	app.DB.Create(&admin)
	app.DB.Create(&normal)
	return
}

// TestAdminRoutesRejectNonAdmin verifies all admin endpoints return 403 for a
// non-admin JWT (AC7).
func TestAdminRoutesRejectNonAdmin(t *testing.T) {
	app, srv, _ := checkinTestApp(t)
	defer srv.Close()
	_, normal := adminUsers(t, app)
	cookie := sessionCookie(t, app, normal.ID, false)

	routes := []struct{ method, path string }{
		{http.MethodGet, "/api/admin/dashboard"},
		{http.MethodGet, "/api/admin/checkin-config"},
		{http.MethodPut, "/api/admin/checkin-config"},
		{http.MethodGet, "/api/admin/activities"},
		{http.MethodPost, "/api/admin/activities"},
		{http.MethodGet, "/api/admin/activities/1/claims"},
		{http.MethodPut, "/api/admin/activities/1"},
		{http.MethodDelete, "/api/admin/activities/1"},
		{http.MethodGet, "/api/admin/grants"},
		{http.MethodPost, "/api/admin/grants/1/retry"},
		{http.MethodPost, "/api/admin/grants/manual"},
		{http.MethodGet, "/api/admin/users"},
		{http.MethodPut, "/api/admin/users/1/status"},
	}
	for _, rt := range routes {
		req := httptest.NewRequest(rt.method, rt.path, nil)
		req.AddCookie(cookie)
		rec := httptest.NewRecorder()
		adminRoutes(app).ServeHTTP(rec, req)
		if rec.Code != http.StatusForbidden {
			t.Errorf("%s %s: expected 403, got %d (%s)", rt.method, rt.path, rec.Code, rec.Body.String())
		}
	}
}

// TestAdminWorkflow exercises the admin CRUD + config + grants + manual flows.
func TestAdminWorkflow(t *testing.T) {
	app, srv, _ := checkinTestApp(t)
	defer srv.Close()
	admin, _ := adminUsers(t, app)
	cookie := sessionCookie(t, app, admin.ID, true)

	// 1. Dashboard.
	rec := perform(adminRoutes(app), http.MethodGet, "/api/admin/dashboard", []*http.Cookie{cookie})
	if rec.Code != http.StatusOK {
		t.Fatalf("dashboard: %d", rec.Code)
	}

	// 2. Checkin config write/read.
	cfgJSON := `{"enabled":true,"timezone":"Asia/Shanghai","mode":"fixed","fixed_quota":12345,"min_quota":0,"max_quota":0,"streak_bonuses":[{"days":3,"bonus":0.1}],"min_trust_level":0}`
	rec = performJSON(adminRoutes(app), http.MethodPut, "/api/admin/checkin-config", cfgJSON, cookie)
	if rec.Code != http.StatusOK {
		t.Fatalf("put config: %d %s", rec.Code, rec.Body.String())
	}
	rec = perform(adminRoutes(app), http.MethodGet, "/api/admin/checkin-config", []*http.Cookie{cookie})
	var cfgResp struct {
		Success bool            `json:"success"`
		Data    json.RawMessage `json:"data"`
	}
	json.Unmarshal(rec.Body.Bytes(), &cfgResp)
	var cfg service.CheckinConfig
	json.Unmarshal(cfgResp.Data, &cfg)
	if cfg.FixedQuota != 12345 || cfg.Mode != "fixed" {
		t.Fatalf("config not persisted: %s", rec.Body.String())
	}

	// 3. Create activity.
	start := time.Now().Add(-time.Hour).Format(time.RFC3339)
	end := time.Now().Add(time.Hour).Format(time.RFC3339)
	actJSON := fmt.Sprintf(`{"title":"新活动","quota":500,"total_count":10,"per_user_limit":1,"min_trust_level":0,"start_at":%q,"end_at":%q,"status":1}`, start, end)
	rec = performJSON(adminRoutes(app), http.MethodPost, "/api/admin/activities", actJSON, cookie)
	if rec.Code != http.StatusOK {
		t.Fatalf("create activity: %d %s", rec.Code, rec.Body.String())
	}
	var actResp struct {
		Success bool           `json:"success"`
		Data    model.Activity `json:"data"`
	}
	json.Unmarshal(rec.Body.Bytes(), &actResp)
	if actResp.Data.ID == 0 || actResp.Data.Title != "新活动" {
		t.Fatalf("activity create response bad: %s", rec.Body.String())
	}
	aid := actResp.Data.ID

	// 4. List + claims.
	rec = perform(adminRoutes(app), http.MethodGet, "/api/admin/activities", []*http.Cookie{cookie})
	var listResp struct {
		Data []model.Activity `json:"data"`
	}
	json.Unmarshal(rec.Body.Bytes(), &listResp)
	if len(listResp.Data) != 1 {
		t.Fatalf("expected 1 activity, got %d", len(listResp.Data))
	}
	rec = perform(adminRoutes(app), http.MethodGet, fmt.Sprintf("/api/admin/activities/%d/claims", aid), []*http.Cookie{cookie})
	if rec.Code != http.StatusOK {
		t.Fatalf("claims: %d", rec.Code)
	}

	// 5. Update (toggle off).
	rec = performJSON(adminRoutes(app), http.MethodPut, fmt.Sprintf("/api/admin/activities/%d", aid), `{"status":2}`, cookie)
	if rec.Code != http.StatusOK {
		t.Fatalf("update activity: %d %s", rec.Code, rec.Body.String())
	}
	rec = perform(adminRoutes(app), http.MethodDelete, fmt.Sprintf("/api/admin/activities/%d", aid), []*http.Cookie{cookie})
	if rec.Code != http.StatusOK {
		t.Fatalf("delete activity: %d", rec.Code)
	}

	// 6. Users list + status toggle.
	rec = perform(adminRoutes(app), http.MethodGet, "/api/admin/users?keyword=alice", []*http.Cookie{cookie})
	if rec.Code != http.StatusOK {
		t.Fatalf("users: %d", rec.Code)
	}
	var usersResp struct {
		Data []model.User `json:"data"`
	}
	json.Unmarshal(rec.Body.Bytes(), &usersResp)
	if len(usersResp.Data) == 0 {
		t.Fatalf("expected users found by keyword")
	}
	uid := usersResp.Data[0].ID
	rec = performJSON(adminRoutes(app), http.MethodPut, fmt.Sprintf("/api/admin/users/%d/status", uid), `{"status":2}`, cookie)
	if rec.Code != http.StatusOK {
		t.Fatalf("toggle status: %d %s", rec.Code, rec.Body.String())
	}
}

// TestAdminRetryFailedGrant configures a manual grant whose payout fails once,
// then verifies retry succeeds without double-paying (R4.4 / AC6).
func TestAdminRetryFailedGrant(t *testing.T) {
	app, srv, db := checkinTestApp(t)
	defer srv.Close()
	admin, _ := adminUsers(t, app)
	cookie := sessionCookie(t, app, admin.ID, true)

	// Create a failed grant manually (simulate an earlier failed checkout).
	failed := model.Grant{UserID: admin.ID, NewapiUserID: 900, Type: "manual", RefID: service.NewManualRefID(), Quota: 1000, Status: service.GrantStatusFailed, Error: "模拟失败"}
	if err := db.Create(&failed).Error; err != nil {
		t.Fatalf("create failed grant: %v", err)
	}

	rec := perform(adminRoutes(app), http.MethodPost, fmt.Sprintf("/api/admin/grants/%d/retry", failed.ID), []*http.Cookie{cookie})
	if rec.Code != http.StatusOK {
		t.Fatalf("retry: %d %s", rec.Code, rec.Body.String())
	}
	var g model.Grant
	if err := db.First(&g, failed.ID).Error; err != nil {
		t.Fatalf("load grant: %v", err)
	}
	if g.Status != service.GrantStatusSuccess {
		t.Fatalf("expected success after retry, got %s", g.Status)
	}
	// No double-payout: still exactly one grant row for this ref.
	var cnt int64
	db.Model(&model.Grant{}).Where("id = ?", failed.ID).Count(&cnt)
	if cnt != 1 {
		t.Fatalf("expected single grant row, got %d", cnt)
	}
}

// TestAdminManualGrant verifies manual payout via newapi_user_id.
func TestAdminManualGrant(t *testing.T) {
	app, srv, _ := checkinTestApp(t)
	defer srv.Close()
	admin, _ := adminUsers(t, app)
	cookie := sessionCookie(t, app, admin.ID, true)

	rec := performJSON(adminRoutes(app), http.MethodPost, "/api/admin/grants/manual", `{"newapi_user_id":42,"quota":777}`, cookie)
	if rec.Code != http.StatusOK {
		t.Fatalf("manual grant: %d %s", rec.Code, rec.Body.String())
	}
	var resp struct {
		Success bool        `json:"success"`
		Data    model.Grant `json:"data"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("parse: %v", err)
	}
	if !resp.Success || resp.Data.Quota != 777 || resp.Data.Status != service.GrantStatusSuccess {
		t.Fatalf("manual grant bad: %s", rec.Body.String())
	}

	// Over-limit quota rejected by MAX_GRANT_QUOTA (5000000 here) or bad input.
	rec2 := performJSON(adminRoutes(app), http.MethodPost, "/api/admin/grants/manual", `{"newapi_user_id":42,"quota":99999999999}`, cookie)
	if rec2.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for over-limit quota, got %d", rec2.Code)
	}
}

// performJSON runs a request with a JSON body.
func performJSON(r *gin.Engine, method, path, body string, cookie *http.Cookie) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	if cookie != nil {
		req.AddCookie(cookie)
	}
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	return rec
}
