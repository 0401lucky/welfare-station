package controller

import (
	"encoding/json"
	"net/http"
	"testing"
	"time"

	"welfare/model"
	"welfare/service"

	"github.com/gin-gonic/gin"
)

func leaderboardRoutes(app *App) *gin.Engine {
	r := gin.New()
	r.GET("/api/leaderboard", app.Auth.OptionalUser(), app.Leaderboard)
	return r
}

// TestLeaderboardEndpoint 验证排行榜接口:匿名 200 且无名次、登录带名次、默认连签榜、非法 kind 400。
func TestLeaderboardEndpoint(t *testing.T) {
	service.ResetLeaderboardCache()
	app, srv, db := checkinTestApp(t)
	defer srv.Close()
	_, alice := adminUsers(t, app)
	today := service.TodayStr(service.DefaultTimezone, time.Now())
	if err := db.Create(&model.Checkin{UserID: alice.ID, CheckinDate: today, Quota: 1, Streak: 4}).Error; err != nil {
		t.Fatalf("create checkin: %v", err)
	}
	if err := db.Create(&model.GamePlay{UserID: alice.ID, GameType: "2048", SessionID: "lb-s1", PlayDate: today, Score: 1234, Reason: "ok"}).Error; err != nil {
		t.Fatalf("create play: %v", err)
	}

	type resp struct {
		Data service.LeaderboardView `json:"data"`
	}
	get := func(t *testing.T, query string, cookies []*http.Cookie) resp {
		t.Helper()
		rec := perform(leaderboardRoutes(app), http.MethodGet, "/api/leaderboard"+query, cookies)
		if rec.Code != http.StatusOK {
			t.Fatalf("leaderboard%s: %d %s", query, rec.Code, rec.Body.String())
		}
		var out resp
		if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
			t.Fatalf("decode: %v", err)
		}
		return out
	}

	anon := get(t, "", nil)
	if anon.Data.Kind != service.LeaderboardKindStreak || len(anon.Data.Items) != 1 || anon.Data.Items[0].Value != 4 || anon.Data.Me != nil {
		t.Fatalf("匿名默认连签榜: %+v", anon.Data)
	}
	if anon.Data.Items[0].Name != "alice" || anon.Data.Items[0].UserID != alice.ID {
		t.Fatalf("榜单只暴露展示名: %+v", anon.Data.Items[0])
	}
	invalid := get(t, "", []*http.Cookie{{Name: service.SessionCookieName, Value: "bad"}})
	if invalid.Data.Me != nil {
		t.Fatal("无效会话应按匿名处理")
	}
	mine := get(t, "?kind=streak", []*http.Cookie{sessionCookie(t, app, alice.ID)})
	if mine.Data.Me == nil || mine.Data.Me.Rank != 1 || mine.Data.Me.Value != 4 {
		t.Fatalf("登录用户应带名次: %+v", mine.Data.Me)
	}
	game := get(t, "?kind=game", []*http.Cookie{sessionCookie(t, app, alice.ID)})
	if game.Data.Kind != service.LeaderboardKindGame || len(game.Data.Items) != 1 || game.Data.Items[0].GameType != "2048" || game.Data.Me == nil || game.Data.Me.Value != 1234 {
		t.Fatalf("高分榜: %+v", game.Data)
	}
	if rec := perform(leaderboardRoutes(app), http.MethodGet, "/api/leaderboard?kind=luck", nil); rec.Code != http.StatusBadRequest {
		t.Fatalf("非法 kind 应 400, got %d", rec.Code)
	}
}
