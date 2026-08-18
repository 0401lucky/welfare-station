package controller

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"welfare/config"
	"welfare/middleware"
	"welfare/model"
	"welfare/service"

	"github.com/gin-gonic/gin"
	"gorm.io/gorm"
)

// checkinTestApp wires an App with a mock new-api that serves both the user
// endpoints and POST /api/user/manage.
func checkinTestApp(t *testing.T) (*App, *httptest.Server, *gorm.DB) {
	t.Helper()
	mux := http.NewServeMux()
	mux.HandleFunc("/api/user/manage", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, map[string]any{"success": true, "message": "", "data": nil})
	})
	mux.HandleFunc("/api/user/", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, map[string]any{"success": true, "message": "", "data": map[string]any{
			"id": 42, "username": "alice", "quota": 100000, "status": 1, "linux_do_id": "10001",
		}})
	})
	srv := httptest.NewServer(mux)

	db := sqliteTestDB()
	if err := model.Migrate(db); err != nil {
		t.Fatalf("migrate: %v", err)
	}

	cfg := testConfig(srv.URL)
	app := NewApp(db, cfg)
	return app, srv, db
}

func testConfig(newapiURL string) *config.Config {
	return &config.Config{
		WelfareBaseURL:   "http://localhost:8080",
		WelfareJWTSecret: "test-secret-test-secret-test-secret-1234",
		NewAPIBaseURL:    newapiURL,
		NewAPIAdminPAT:   "pat",
		AdminLinuxDOIDs:  map[string]bool{"90001": true},
		MockOAuth:        true,
		QuotaPerUnit:     500000,
		MaxGrantQuota:    5000000,
	}
}

func checkinRoutes(app *App) *gin.Engine {
	r := gin.New()
	api := r.Group("/api")
	user := api.Group("", app.Auth.RequireUser())
	user.GET("/checkin", app.GetCheckin)
	user.POST("/checkin", middleware.RateLimitUser(), app.DoCheckin)
	return r
}

func checkinUser(t *testing.T, app *App) *http.Cookie {
	t.Helper()
	u := model.User{LinuxDOID: "10001", LinuxDOName: "alice", DisplayName: "Alice", TrustLevel: 2, Status: 1, NewapiUserID: int64p(42), NewapiUsername: "alice"}
	if err := app.DB.Create(&u).Error; err != nil {
		t.Fatalf("create user: %v", err)
	}
	return sessionCookie(t, app, u.ID, false)
}

func int64p(i int64) *int64 { return &i }

// TestCheckinPostFlow verifies POST /api/checkin succeeds and returns quota/streak.
func TestCheckinPostFlow(t *testing.T) {
	app, srv, db := checkinTestApp(t)
	defer srv.Close()

	// Seed fixed checkin config so the reward is deterministic.
	cfg := service.DefaultCheckinConfig()
	cfg.Mode = "fixed"
	cfg.FixedQuota = 1000
	cfg.StreakBonuses = []service.StreakBonus{}
	if err := service.SaveCheckinConfig(db, cfg); err != nil {
		t.Fatalf("save config: %v", err)
	}

	cookie := checkinUser(t, app)
	rec := perform(checkinRoutes(app), http.MethodPost, "/api/checkin", []*http.Cookie{cookie})
	if rec.Code != http.StatusOK {
		t.Fatalf("checkin got %d: %s", rec.Code, rec.Body.String())
	}
	var res struct {
		Success bool `json:"success"`
		Data    struct {
			Quota      int64  `json:"quota"`
			Streak     int    `json:"streak"`
			GrantState string `json:"grant_status"`
		} `json:"data"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &res); err != nil {
		t.Fatalf("parse: %v", err)
	}
	if !res.Success || res.Data.Quota != 1000 || res.Data.Streak != 1 || res.Data.GrantState != service.GrantStatusSuccess {
		t.Fatalf("unexpected response: %+v", res)
	}

	// Second check-in the same day is rejected.
	rec2 := perform(checkinRoutes(app), http.MethodPost, "/api/checkin", []*http.Cookie{cookie})
	if rec2.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 on duplicate checkin, got %d: %s", rec2.Code, rec2.Body.String())
	}

	// GET /api/checkin shows today checked + calendar.
	rec3 := perform(checkinRoutes(app), http.MethodGet, "/api/checkin", []*http.Cookie{cookie})
	if rec3.Code != http.StatusOK {
		t.Fatalf("get checkin got %d", rec3.Code)
	}
	var view struct {
		Data struct {
			CheckedToday bool     `json:"checked_today"`
			Calendar     []string `json:"calendar"`
		} `json:"data"`
	}
	if err := json.Unmarshal(rec3.Body.Bytes(), &view); err != nil {
		t.Fatalf("parse view: %v", err)
	}
	if !view.Data.CheckedToday || len(view.Data.Calendar) != 1 {
		t.Fatalf("unexpected calendar: checked=%v calendar=%v", view.Data.CheckedToday, view.Data.Calendar)
	}
}
