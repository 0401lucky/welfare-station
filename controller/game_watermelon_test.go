package controller

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"welfare/model"
	"welfare/service"
	"welfare/service/gamewatermelon"
)

func enableWatermelon(t *testing.T, app *App) {
	t.Helper()
	cfg, err := service.GetGameConfig(app.DB)
	if err != nil {
		t.Fatal(err)
	}
	rules := service.DefaultWatermelonRules()
	rules.CooldownSeconds = 0
	rules.Tiers = []service.GameTier{{Tile: 4, Quota: 1000}}
	cfg.Games[gamewatermelon.GameType] = rules
	if err := service.SaveGameConfig(app.DB, cfg, app.Config.MaxGrantQuota); err != nil {
		t.Fatal(err)
	}
}
func startWatermelonHTTP(t *testing.T, app *App, cookie *http.Cookie) service.StartResult {
	t.Helper()
	rec := performJSON(gameRoutes(app), http.MethodPost, "/api/games/watermelon/start", "", cookie)
	if rec.Code != http.StatusOK {
		t.Fatalf("start %d: %s", rec.Code, rec.Body.String())
	}
	var resp struct {
		Data service.StartResult `json:"data"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatal(err)
	}
	return resp.Data
}
func watermelonBody(t *testing.T, id string, baseTick, baseMoves, toTick int, drops []gamewatermelon.Drop) string {
	t.Helper()
	if drops == nil {
		drops = []gamewatermelon.Drop{}
	}
	raw, err := json.Marshal(service.WatermelonSegment{SessionID: id, BaseTick: baseTick, BaseMoves: baseMoves, ToTick: toTick, Drops: drops})
	if err != nil {
		t.Fatal(err)
	}
	return string(raw)
}

func TestWatermelonHTTPCheckpointTokensAndQuota(t *testing.T) {
	app, srv, db := checkinTestApp(t)
	defer srv.Close()
	enableWatermelon(t, app)
	cookie := checkinUser(t, app)
	start := startWatermelonHTTP(t, app, cookie)
	if start.EngineVersion != gamewatermelon.Version || start.TickRate != 120 || start.Limits.MaxSegmentTicks != 600 || start.State == nil || *start.BaseTick != 0 {
		t.Fatalf("start payload: %+v", start)
	}
	if err := db.Model(&model.GameSession{}).Where("id = ?", start.SessionID).Updates(map[string]any{"seed": "0123456789abcdef0123456789abcdef", "started_at": time.Now().Add(-time.Minute)}).Error; err != nil {
		t.Fatal(err)
	}
	drops := []gamewatermelon.Drop{{Tick: 0, X: 180}, {Tick: 91, X: 180}, {Tick: 182, X: 180}, {Tick: 273, X: 180}}
	first := watermelonBody(t, start.SessionID, 0, 0, 311, drops)
	rec := performJSON(gameRoutes(app), http.MethodPost, "/api/games/watermelon/checkpoint", first, cookie)
	if rec.Code != http.StatusOK {
		t.Fatalf("checkpoint %d: %s", rec.Code, rec.Body.String())
	}
	var cp struct {
		Data service.WatermelonCheckpointResult `json:"data"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &cp); err != nil {
		t.Fatal(err)
	}
	if cp.Data.BaseMoves != 4 || *cp.Data.BaseTick != 311 || cp.Data.State.Tick != 311 {
		t.Fatalf("checkpoint recovery payload: %+v", cp)
	}
	for _, action := range []string{"checkpoint", "submit"} {
		rec = performJSON(gameRoutes(app), http.MethodPost, "/api/games/watermelon/"+action, first, cookie)
		if rec.Code != http.StatusConflict {
			t.Fatalf("%s stale token should409, got %d %s", action, rec.Code, rec.Body.String())
		}
	}
	final := watermelonBody(t, start.SessionID, 311, 4, 600, []gamewatermelon.Drop{{Tick: 364, X: 180}, {Tick: 455, X: 180}, {Tick: 546, X: 180}})
	for i := 0; i < 2; i++ {
		rec = performJSON(gameRoutes(app), http.MethodPost, "/api/games/watermelon/submit", final, cookie)
		if rec.Code != http.StatusOK {
			t.Fatalf("submit %d: %s", rec.Code, rec.Body.String())
		}
		var result struct {
			Success bool `json:"success"`
			Data    struct {
				Quota       int64  `json:"quota"`
				Highest     int    `json:"highest_tile"`
				Moves       int    `json:"moves"`
				GrantStatus string `json:"grant_status"`
			} `json:"data"`
		}
		if err := json.Unmarshal(rec.Body.Bytes(), &result); err != nil {
			t.Fatal(err)
		}
		if !result.Success || result.Data.Quota != 1000 || result.Data.Highest < 4 || result.Data.Moves != 7 || result.Data.GrantStatus != service.GameGrantSuccess {
			t.Fatalf("verified payout body: %s", rec.Body.String())
		}
	}
	var grants, plays int64
	db.Model(&model.Grant{}).Count(&grants)
	db.Model(&model.GamePlay{}).Count(&plays)
	if grants != 1 || plays != 1 {
		t.Fatalf("repeat submit granted twice: %d/%d", grants, plays)
	}
	rec = performJSON(gameRoutes(app), http.MethodPost, "/api/games/2048/submit", movesJSON(start.SessionID, 0, nil), cookie)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("cross-game settled replay: %d %s", rec.Code, rec.Body.String())
	}
	rec = performJSON(gameRoutes(app), http.MethodGet, "/api/games/watermelon/status", "", cookie)
	var status struct {
		Data service.GameStatusView `json:"data"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &status); err != nil {
		t.Fatal(err)
	}
	if status.Data.TodayQuota != 1000 || status.Data.TodayClaims != 1 || status.Data.ActiveSession != nil || len(status.Data.RecentPlays) != 1 {
		t.Fatalf("settled status: %s", rec.Body.String())
	}
}

func TestWatermelonHTTPRejectsForgedAndOversizedInputsWithoutWrites(t *testing.T) {
	app, srv, db := checkinTestApp(t)
	defer srv.Close()
	enableWatermelon(t, app)
	cookie := checkinUser(t, app)
	start := startWatermelonHTTP(t, app, cookie)
	base := watermelonBody(t, start.SessionID, 0, 0, 0, nil)
	bad := []string{
		strings.TrimSuffix(base, "}") + `,"score":999999,"highest":8,"state":{},"quota":999999}`,
		base + strings.Repeat(" ", gamewatermelon.MaxRequestBytes),
		base + base,
		fmt.Sprintf(`{"session_id":%q,"base_tick":0,"base_moves":0,"to_tick":600,"drops":[]}`, start.SessionID),
		fmt.Sprintf(`{"session_id":%q,"base_tick":0,"base_moves":0,"to_tick":601,"drops":[]}`, start.SessionID),
		strings.Replace(base, `"base_tick":0`, `"base_tick":0.25`, 1),
		strings.Replace(base, `"base_moves":0`, `"base_moves":null`, 1),
		strings.Replace(base, `"drops":[]`, `"drops":[{"tick":0}]`, 1),
		strings.Replace(base, `"drops":[]`, `"drops":[{"tick":0,"x":1e50}]`, 1),
		strings.Replace(base, `"drops":[]`, `"drops":[{"tick":0,"x":-1}]`, 1),
		strings.Replace(base, `"drops":[]`, `"drops":[{"tick":0,"x":180},{"tick":0,"x":180}]`, 1),
		strings.Replace(base, `"drops":[]`, `"drops":null`, 1),
	}
	var before model.GameSession
	if err := db.First(&before, "id = ?", start.SessionID).Error; err != nil {
		t.Fatal(err)
	}
	for i, body := range bad {
		for _, action := range []string{"checkpoint", "submit"} {
			rec := performJSON(gameRoutes(app), http.MethodPost, "/api/games/watermelon/"+action, body, cookie)
			if rec.Code != http.StatusBadRequest {
				t.Fatalf("bad input%d %s: got%d %s", i, action, rec.Code, rec.Body.String())
			}
		}
	}
	var after model.GameSession
	if err := db.First(&after, "id = ?", start.SessionID).Error; err != nil {
		t.Fatal(err)
	}
	if after.Payload != before.Payload || !after.UpdatedAt.Equal(before.UpdatedAt) || !after.ExpiresAt.Equal(before.ExpiresAt) {
		t.Fatal("rejected input changed saved particles/expiry")
	}
	for _, m := range []any{&model.GamePlay{}, &model.Grant{}, &model.DailyBudget{}} {
		var count int64
		db.Model(m).Count(&count)
		if count != 0 {
			t.Fatalf("invalid input wrote %T", m)
		}
	}
}

func TestWatermelonRoutesRequireBoundAuthenticatedAccount(t *testing.T) {
	app, srv, _ := checkinTestApp(t)
	defer srv.Close()
	enableWatermelon(t, app)
	for _, action := range []string{"start", "checkpoint", "submit", "cancel", "status"} {
		method := http.MethodPost
		if action == "status" {
			method = http.MethodGet
		}
		rec := performJSON(gameRoutes(app), method, "/api/games/watermelon/"+action, "", nil)
		if rec.Code != http.StatusUnauthorized {
			t.Fatalf("%s requires auth: %d", action, rec.Code)
		}
	}
	cookie := checkinUser(t, app)
	if err := app.DB.Model(&model.User{}).Where("1=1").Update("newapi_user_id", nil).Error; err != nil {
		t.Fatal(err)
	}
	rec := performJSON(gameRoutes(app), http.MethodPost, "/api/games/watermelon/start", "", cookie)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("unbound start: %d %s", rec.Code, rec.Body.String())
	}
}

func TestWatermelonHTTPFailedDeliveryReturnsCompletedSettlementData(t *testing.T) {
	app, srv, db := checkinTestApp(t)
	defer srv.Close()
	enableWatermelon(t, app)
	var calls atomic.Int32
	failing := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		writeJSON(w, http.StatusOK, map[string]any{"success": false, "message": "test payout unavailable"})
	}))
	defer failing.Close()
	app.NewAPI = service.NewNewAPIClient(failing.URL, "test-pat")
	cookie := checkinUser(t, app)
	start := startWatermelonHTTP(t, app, cookie)
	if err := db.Model(&model.GameSession{}).Where("id = ?", start.SessionID).Updates(map[string]any{"seed": "0123456789abcdef0123456789abcdef", "started_at": time.Now().Add(-time.Minute)}).Error; err != nil {
		t.Fatal(err)
	}
	drops := []gamewatermelon.Drop{}
	for tick := 0; tick <= 600; tick += 91 {
		drops = append(drops, gamewatermelon.Drop{Tick: tick, X: 180})
	}
	body := watermelonBody(t, start.SessionID, 0, 0, 600, drops)
	for attempt := 0; attempt < 2; attempt++ {
		rec := performJSON(gameRoutes(app), http.MethodPost, "/api/games/watermelon/submit", body, cookie)
		var result struct {
			Success bool `json:"success"`
			Data    struct {
				Quota       int64  `json:"quota"`
				Reason      string `json:"reason"`
				GrantStatus string `json:"grant_status"`
			} `json:"data"`
		}
		if err := json.Unmarshal(rec.Body.Bytes(), &result); err != nil {
			t.Fatal(err)
		}
		if rec.Code != http.StatusOK || result.Data.Quota != 1000 || result.Data.Reason != service.GameReasonOK || result.Data.GrantStatus != service.GameGrantFailed {
			t.Fatalf("completed failure data missing: %d %s", rec.Code, rec.Body.String())
		}
		if attempt == 0 && result.Success {
			t.Fatal("initial failed delivery must use the existing ApiError.data response")
		}
	}
	var grant model.Grant
	if err := db.First(&grant).Error; err != nil {
		t.Fatal(err)
	}
	if grant.Status != service.GrantStatusFailed || calls.Load() != 1 {
		t.Fatalf("failed delivery was resent: %+v calls=%d", grant, calls.Load())
	}
}

func TestWatermelonCancelDoesNotDeleteANewerOrForeignRound(t *testing.T) {
	app, srv, db := checkinTestApp(t)
	defer srv.Close()
	enableWatermelon(t, app)
	cookie := checkinUser(t, app)
	cancel := func(id string) {
		t.Helper()
		rec := performJSON(gameRoutes(app), http.MethodPost, "/api/games/watermelon/cancel", fmt.Sprintf(`{"session_id":%q}`, id), cookie)
		if rec.Code != http.StatusOK {
			t.Fatalf("cancel: %d %s", rec.Code, rec.Body.String())
		}
	}
	old := startWatermelonHTTP(t, app, cookie)
	cancel(old.SessionID)
	current := startWatermelonHTTP(t, app, cookie)
	legacy := startGame(t, app, cookie)
	other := model.User{LinuxDOID: "watermelon-other", LinuxDOName: "other", Status: 1, NewapiUserID: int64p(43)}
	if err := db.Create(&other).Error; err != nil {
		t.Fatal(err)
	}
	foreign := startWatermelonHTTP(t, app, sessionCookie(t, app, other.ID, false))
	for _, id := range []string{old.SessionID, legacy.SessionID, foreign.SessionID, strings.Repeat("a", 32)} {
		cancel(id)
		for _, keep := range []string{current.SessionID, legacy.SessionID, foreign.SessionID} {
			var count int64
			if err := db.Model(&model.GameSession{}).Where("id = ?", keep).Count(&count).Error; err != nil {
				t.Fatal(err)
			}
			if count != 1 {
				t.Fatalf("canceling %s deleted unrelated session %s", id, keep)
			}
		}
	}
	cancel(current.SessionID)
	var remaining int64
	if err := db.Model(&model.GameSession{}).Where("id = ?", current.SessionID).Count(&remaining).Error; err != nil || remaining != 0 {
		t.Fatalf("current session was not canceled: count=%d err=%v", remaining, err)
	}
	// Legacy 2048 callers still send an empty body.
	rec := performJSON(gameRoutes(app), http.MethodPost, "/api/games/2048/cancel", "", cookie)
	if rec.Code != http.StatusOK {
		t.Fatalf("legacy cancel changed: %d %s", rec.Code, rec.Body.String())
	}
	for _, value := range []any{&model.GamePlay{}, &model.Grant{}, &model.DailyBudget{}} {
		var count int64
		if err := db.Model(value).Count(&count).Error; err != nil || count != 0 {
			t.Fatalf("cancel wrote %T: count=%d err=%v", value, count, err)
		}
	}
}

func TestWatermelonCancelRequiresABoundedValidSessionID(t *testing.T) {
	app, srv, db := checkinTestApp(t)
	defer srv.Close()
	enableWatermelon(t, app)
	cookie := checkinUser(t, app)
	start := startWatermelonHTTP(t, app, cookie)
	body := fmt.Sprintf(`{"session_id":%q}`, start.SessionID)
	for _, invalid := range []string{
		"", `{}`, `null`, `[]`, `{"session_id":null}`, `{"session_id":1}`,
		`{"session_id":""}`, `{"session_id":"not-a-session"}`, fmt.Sprintf(`{"session_id":%q}`, strings.Repeat("z", 32)),
		body + body, body + strings.Repeat(" ", gamewatermelon.MaxRequestBytes),
		strings.TrimSuffix(body, "}") + `,"state":{}}`,
	} {
		rec := performJSON(gameRoutes(app), http.MethodPost, "/api/games/watermelon/cancel", invalid, cookie)
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("invalid cancel accepted: %d %s", rec.Code, rec.Body.String())
		}
		var count int64
		if err := db.Model(&model.GameSession{}).Where("id = ?", start.SessionID).Count(&count).Error; err != nil || count != 1 {
			t.Fatalf("invalid cancel changed live session: count=%d err=%v", count, err)
		}
	}
}
