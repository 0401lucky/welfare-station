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
	admin.GET("/admin/game-config", app.AdminGetGameConfig)
	admin.PUT("/admin/game-config", app.AdminPutGameConfig)
	admin.GET("/admin/budgets", app.AdminBudgets)
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
		{http.MethodGet, "/api/admin/game-config"},
		{http.MethodPut, "/api/admin/game-config"},
		{http.MethodGet, "/api/admin/budgets"},
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
	offJSON := fmt.Sprintf(`{"title":"新活动","quota":500,"total_count":10,"per_user_limit":1,"min_trust_level":0,"start_at":%q,"end_at":%q,"status":2}`, start, end)
	rec = performJSON(adminRoutes(app), http.MethodPut, fmt.Sprintf("/api/admin/activities/%d", aid), offJSON, cookie)
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

// TestAdminUpdateActivity 覆盖编辑活动：RFC3339 时间可落库（回归 500 bug）、
// 可保存为下架、claimed_count 不被请求体改写、total_count 不得小于已领取数。
func TestAdminUpdateActivity(t *testing.T) {
	app, srv, db := checkinTestApp(t)
	defer srv.Close()
	admin, _ := adminUsers(t, app)
	cookie := sessionCookie(t, app, admin.ID, true)

	start := time.Now().Add(-time.Hour).UTC()
	end := time.Now().Add(24 * time.Hour).UTC()
	act := model.Activity{
		Title: "原标题", Quota: 500, TotalCount: 10, ClaimedCount: 3,
		PerUserLimit: 1, MinTrustLevel: 0, StartAt: start, EndAt: end,
		Status: service.ActivityStatusOn,
	}
	if err := db.Create(&act).Error; err != nil {
		t.Fatalf("准备活动失败: %v", err)
	}
	path := fmt.Sprintf("/api/admin/activities/%d", act.ID)

	// 1+2+3. 正常更新：带毫秒的 RFC3339 时间（前端 toISOString 格式），状态改为下架。
	// 时间必须相对 now 计算：硬编码日期在真实时间越过它之后就会 end < start，
	// 触发「结束时间需晚于开始时间」而必然失败。毫秒固定为 .589 保持断言确定性。
	newEnd := time.Now().UTC().Add(48 * time.Hour).Truncate(time.Second).
		Add(589 * time.Millisecond).Format("2006-01-02T15:04:05.000Z")
	body := fmt.Sprintf(`{"title":"改后标题","description":"说明","quota":800,"total_count":12,`+
		`"per_user_limit":2,"min_trust_level":1,"start_at":%q,"end_at":%q,"status":2}`,
		start.Format(time.RFC3339), newEnd)
	rec := performJSON(adminRoutes(app), http.MethodPut, path, body, cookie)
	if rec.Code != http.StatusOK {
		t.Fatalf("更新应返回 200，实际 %d %s", rec.Code, rec.Body.String())
	}
	var got model.Activity
	db.First(&got, act.ID)
	if got.Title != "改后标题" || got.Quota != 800 || got.TotalCount != 12 || got.PerUserLimit != 2 || got.MinTrustLevel != 1 {
		t.Fatalf("字段未正确落库: %+v", got)
	}
	if got.Status != service.ActivityStatusOff {
		t.Fatalf("状态应保存为下架(2)，实际 %d", got.Status)
	}
	wantEnd, _ := time.Parse(time.RFC3339, newEnd)
	if !got.EndAt.UTC().Truncate(time.Second).Equal(wantEnd.UTC().Truncate(time.Second)) {
		t.Fatalf("结束时间未正确落库: got %v want %v", got.EndAt, wantEnd)
	}

	// 4. 请求体里的 claimed_count 必须被忽略。
	body = fmt.Sprintf(`{"title":"改后标题","quota":800,"total_count":12,"per_user_limit":2,`+
		`"min_trust_level":1,"start_at":%q,"end_at":%q,"status":2,"claimed_count":999,"id":4242}`,
		start.Format(time.RFC3339), newEnd)
	rec = performJSON(adminRoutes(app), http.MethodPut, path, body, cookie)
	if rec.Code != http.StatusOK {
		t.Fatalf("更新应返回 200，实际 %d %s", rec.Code, rec.Body.String())
	}
	db.First(&got, act.ID)
	if got.ClaimedCount != 3 {
		t.Fatalf("claimed_count 不应被请求体改写，实际 %d", got.ClaimedCount)
	}

	// 5. total_count 小于已领取数 → 400。
	body = fmt.Sprintf(`{"title":"改后标题","quota":800,"total_count":1,"per_user_limit":1,`+
		`"min_trust_level":0,"start_at":%q,"end_at":%q,"status":1}`,
		start.Format(time.RFC3339), newEnd)
	rec = performJSON(adminRoutes(app), http.MethodPut, path, body, cookie)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("total_count 小于已领取数应返回 400，实际 %d %s", rec.Code, rec.Body.String())
	}
	db.First(&got, act.ID)
	if got.TotalCount != 12 {
		t.Fatalf("校验失败时不应写库，实际 total_count=%d", got.TotalCount)
	}
}

// parseGameConfig 从统一响应信封里取出 data 段的游戏配置。
func parseGameConfig(t *testing.T, rec *httptest.ResponseRecorder) service.GameConfig {
	t.Helper()
	var resp struct {
		Success bool               `json:"success"`
		Data    service.GameConfig `json:"data"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("解析游戏配置响应失败: %v (%s)", err, rec.Body.String())
	}
	return resp.Data
}

// failMessage 取响应里的 message,用来断言校验失败时站长看得出问题在哪。
func failMessage(t *testing.T, rec *httptest.ResponseRecorder) string {
	t.Helper()
	var resp struct {
		Message string `json:"message"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("解析响应失败: %v (%s)", err, rec.Body.String())
	}
	return resp.Message
}

// gameConfigJSON 拼一份完整的 game_config 请求体,tiers/budgets 由调用方给。
func gameConfigJSON(tiers, budgets string) string {
	return `{"timezone":"Asia/Shanghai","games":{"2048":{"enabled":true,"reward_type":"permanent",` +
		`"daily_claim_limit":3,"user_daily_cap":150000,"cooldown_seconds":5,"tiers":[` + tiers + `]}},` +
		`"budgets":{` + budgets + `}}`
}

// TestAdminGameConfig 覆盖游戏配置的读写与校验：默认值可读、非 2 的幂档位被拒、
// 单档超 MAX_GRANT_QUOTA 被拒、乱序档位保存后按 tile 升序归一化、未知预算池被拒。
func TestAdminGameConfig(t *testing.T) {
	app, srv, _ := checkinTestApp(t)
	defer srv.Close()
	admin, _ := adminUsers(t, app)
	cookie := sessionCookie(t, app, admin.ID, true)

	// 1. 首次 GET 播种默认配置。
	rec := perform(adminRoutes(app), http.MethodGet, "/api/admin/game-config", []*http.Cookie{cookie})
	if rec.Code != http.StatusOK {
		t.Fatalf("读配置应返回 200，实际 %d %s", rec.Code, rec.Body.String())
	}
	def := parseGameConfig(t, rec)
	if len(def.Games) == 0 || len(def.Budgets) != len(service.BudgetScopes) {
		t.Fatalf("默认配置应含 games 与四个预算池: %s", rec.Body.String())
	}

	okBudgets := `"total":{"enabled":false,"daily":0},"game":{"enabled":true,"daily":10000000},` +
		`"checkin":{"enabled":false,"daily":0},"activity":{"enabled":false,"daily":0}`

	// 2. tile=1000 不是 2 的幂 → 400，且 message 指得出是哪一档。
	rec = performJSON(adminRoutes(app), http.MethodPut, "/api/admin/game-config",
		gameConfigJSON(`{"tile":1000,"quota":10000}`, okBudgets), cookie)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("tile=1000 应返回 400，实际 %d %s", rec.Code, rec.Body.String())
	}
	if msg := failMessage(t, rec); !strings.Contains(msg, "1000") {
		t.Fatalf("错误信息应指出问题档位 tile=1000，实际 %q", msg)
	}

	// 3. 单档 quota 超 MAX_GRANT_QUOTA(测试配置为 5000000)→ 400。
	rec = performJSON(adminRoutes(app), http.MethodPut, "/api/admin/game-config",
		gameConfigJSON(`{"tile":512,"quota":9999999}`, okBudgets), cookie)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("超上限 quota 应返回 400，实际 %d %s", rec.Code, rec.Body.String())
	}
	if msg := failMessage(t, rec); !strings.Contains(msg, "5000000") {
		t.Fatalf("错误信息应带出上限值，实际 %q", msg)
	}

	// 4. 乱序 tiers → 200，且响应里已按 tile 升序（MatchTier 依赖这个顺序）。
	rec = performJSON(adminRoutes(app), http.MethodPut, "/api/admin/game-config",
		gameConfigJSON(`{"tile":2048,"quota":100000},{"tile":512,"quota":10000},{"tile":1024,"quota":25000}`,
			okBudgets), cookie)
	if rec.Code != http.StatusOK {
		t.Fatalf("合法配置应返回 200，实际 %d %s", rec.Code, rec.Body.String())
	}
	saved := parseGameConfig(t, rec)
	wantTiles := []int{512, 1024, 2048}
	gotTiers := saved.Games["2048"].Tiers
	if len(gotTiers) != len(wantTiles) {
		t.Fatalf("应保存 3 档，实际 %d 档: %s", len(gotTiers), rec.Body.String())
	}
	for i, want := range wantTiles {
		if gotTiers[i].Tile != want {
			t.Fatalf("响应中的档位应按 tile 升序，第 %d 档为 %d，期望 %d", i, gotTiers[i].Tile, want)
		}
	}
	// 再 GET 一次，确认落库的也是归一化后的顺序。
	rec = perform(adminRoutes(app), http.MethodGet, "/api/admin/game-config", []*http.Cookie{cookie})
	reloaded := parseGameConfig(t, rec)
	for i, want := range wantTiles {
		if reloaded.Games["2048"].Tiers[i].Tile != want {
			t.Fatalf("落库的档位顺序不对: %s", rec.Body.String())
		}
	}

	// 5. 未知预算池 → 400。
	rec = performJSON(adminRoutes(app), http.MethodPut, "/api/admin/game-config",
		gameConfigJSON(`{"tile":512,"quota":10000}`, `"lottery":{"enabled":true,"daily":100}`), cookie)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("未知预算池应返回 400，实际 %d %s", rec.Code, rec.Body.String())
	}
	if msg := failMessage(t, rec); !strings.Contains(msg, "lottery") {
		t.Fatalf("错误信息应指出未知池名，实际 %q", msg)
	}

	// 6. 非法配置不得写库：档位应仍是第 4 步保存的那三档。
	rec = perform(adminRoutes(app), http.MethodGet, "/api/admin/game-config", []*http.Cookie{cookie})
	if n := len(parseGameConfig(t, rec).Games["2048"].Tiers); n != 3 {
		t.Fatalf("校验失败时不应写库，实际档位数 %d: %s", n, rec.Body.String())
	}
}

// TestAdminBudgets 覆盖预算看板：合并配置上限与实际用量、四个池齐全、
// remaining 计算正确（未开启的池给 0 而非负数）、days 非法值回落 7。
func TestAdminBudgets(t *testing.T) {
	app, srv, db := checkinTestApp(t)
	defer srv.Close()
	admin, _ := adminUsers(t, app)
	cookie := sessionCookie(t, app, admin.ID, true)

	// 默认配置：game 池开启、预算 10000000；total 池关闭、预算 0。
	today := service.TodayStr("Asia/Shanghai", time.Now())
	for _, row := range []model.DailyBudget{
		{Date: today, Scope: service.BudgetScopeGame, Used: 123456},
		{Date: today, Scope: service.BudgetScopeTotal, Used: 1000},
	} {
		if err := db.Create(&row).Error; err != nil {
			t.Fatalf("准备预算用量失败: %v", err)
		}
	}

	type scopeView struct {
		Scope     string `json:"scope"`
		Enabled   bool   `json:"enabled"`
		Daily     int64  `json:"daily"`
		UsedToday int64  `json:"used_today"`
		Remaining int64  `json:"remaining"`
	}
	var resp struct {
		Data struct {
			Timezone string      `json:"timezone"`
			Today    string      `json:"today"`
			Scopes   []scopeView `json:"scopes"`
			History  []struct {
				Date string           `json:"date"`
				Used map[string]int64 `json:"used"`
			} `json:"history"`
		} `json:"data"`
	}

	rec := perform(adminRoutes(app), http.MethodGet, "/api/admin/budgets?days=7", []*http.Cookie{cookie})
	if rec.Code != http.StatusOK {
		t.Fatalf("预算看板应返回 200，实际 %d %s", rec.Code, rec.Body.String())
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("解析预算响应失败: %v (%s)", err, rec.Body.String())
	}
	if resp.Data.Today != today {
		t.Fatalf("today 应为 %s，实际 %s", today, resp.Data.Today)
	}
	if len(resp.Data.Scopes) != len(service.BudgetScopes) {
		t.Fatalf("应返回四个池，实际 %d 个: %s", len(resp.Data.Scopes), rec.Body.String())
	}
	byScope := map[string]scopeView{}
	for _, s := range resp.Data.Scopes {
		byScope[s.Scope] = s
	}
	for _, want := range service.BudgetScopes {
		if _, ok := byScope[want]; !ok {
			t.Fatalf("缺少预算池 %s: %s", want, rec.Body.String())
		}
	}
	game := byScope[service.BudgetScopeGame]
	if game.UsedToday != 123456 || game.Daily != 10000000 || !game.Enabled {
		t.Fatalf("game 池数据不对: %+v", game)
	}
	if game.Remaining != 10000000-123456 {
		t.Fatalf("game 池剩余应为 %d，实际 %d", 10000000-123456, game.Remaining)
	}
	total := byScope[service.BudgetScopeTotal]
	// 未开启的池仍要报出已用量，但剩余给 0——不能因为 daily=0 而算出负数。
	if total.Enabled || total.UsedToday != 1000 || total.Remaining != 0 {
		t.Fatalf("未开启的 total 池应 remaining=0 且如实报用量: %+v", total)
	}
	if n := len(resp.Data.History); n != 7 {
		t.Fatalf("days=7 应返回 7 天曲线，实际 %d", n)
	}
	if last := resp.Data.History[len(resp.Data.History)-1]; last.Date != today || last.Used[service.BudgetScopeGame] != 123456 {
		t.Fatalf("曲线最后一项应是今日用量: %+v", last)
	}

	// days 非法值（非数字 / 0 / 负数）一律回落 7；合法值照常生效。
	for _, tc := range []struct {
		query string
		want  int
	}{{"?days=abc", 7}, {"?days=0", 7}, {"?days=-3", 7}, {"", 7}, {"?days=2", 2}} {
		rec = perform(adminRoutes(app), http.MethodGet, "/api/admin/budgets"+tc.query, []*http.Cookie{cookie})
		if rec.Code != http.StatusOK {
			t.Fatalf("budgets%s 应返回 200，实际 %d", tc.query, rec.Code)
		}
		resp.Data.History = nil
		if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
			t.Fatalf("解析预算响应失败: %v", err)
		}
		if len(resp.Data.History) != tc.want {
			t.Fatalf("budgets%s 应返回 %d 天，实际 %d", tc.query, tc.want, len(resp.Data.History))
		}
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
