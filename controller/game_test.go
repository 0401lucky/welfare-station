package controller

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"testing"

	"welfare/middleware"
	"welfare/model"
	"welfare/service"
	"welfare/service/game2048"

	"github.com/gin-gonic/gin"
)

func gameRoutes(app *App) *gin.Engine {
	r := gin.New()
	api := r.Group("/api")
	user := api.Group("", app.Auth.RequireUser())
	user.GET("/games", app.ListGames)
	user.GET("/games/:game/status", app.GameStatus)
	// 测试里不挂限流中间件:令牌桶是进程级全局单例,跨用例会互相串扰。
	// 限流本身由 TestGameLimiterIsSeparateFromCheckin 单独覆盖。
	user.POST("/games/:game/start", app.GameStart)
	user.POST("/games/:game/checkpoint", app.GameCheckpoint)
	user.POST("/games/:game/submit", app.GameSubmit)
	user.POST("/games/:game/cancel", app.GameCancel)
	return r
}

// enableGame 落一份「合成 8 就给 1000」的宽松配置,方便用少量步数触发发放。
func enableGame(t *testing.T, app *App) {
	t.Helper()
	cfg, err := service.GetGameConfig(app.DB)
	if err != nil {
		t.Fatalf("读配置: %v", err)
	}
	cfg.Games[game2048.GameType2048] = service.GameRules{
		Enabled:         true,
		RewardType:      service.QuotaTypePermanent,
		DailyClaimLimit: 3,
		UserDailyCap:    1000000,
		CooldownSeconds: 0,
		Tiers:           []service.GameTier{{Tile: 8, Quota: 1000}},
	}
	if err := service.SaveGameConfig(app.DB, cfg, app.Config.MaxGrantQuota); err != nil {
		t.Fatalf("存配置: %v", err)
	}
}

func startGame(t *testing.T, app *App, cookie *http.Cookie) service.StartResult {
	t.Helper()
	rec := performJSON(gameRoutes(app), http.MethodPost, "/api/games/2048/start", "", cookie)
	if rec.Code != http.StatusOK {
		t.Fatalf("开局失败: %d %s", rec.Code, rec.Body.String())
	}
	var resp struct {
		Data service.StartResult `json:"data"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("解析开局响应: %v", err)
	}
	return resp.Data
}

// movesJSON 把方向序列拼成 submit/checkpoint 的请求体。
func movesJSON(sessionID string, baseMoves int, dirs []string) string {
	quoted := make([]string, len(dirs))
	for i, d := range dirs {
		quoted[i] = fmt.Sprintf("%q", d)
	}
	return fmt.Sprintf(`{"session_id":%q,"base_moves":%d,"moves":[%s]}`,
		sessionID, baseMoves, strings.Join(quoted, ","))
}

func repeatDirs(n int) []string {
	out := make([]string, 0, n)
	cycle := []string{"left", "up", "right", "down"}
	for i := 0; i < n; i++ {
		out = append(out, cycle[i%len(cycle)])
	}
	return out
}

// TestGameSubmitCannotSpecifyScore 是 AC2 的正面断言:
// 请求体里塞 score / quota / highest_tile 一律无效,服务端只认 moves 的回放结果。
func TestGameSubmitCannotSpecifyScore(t *testing.T) {
	app, srv, db := checkinTestApp(t)
	defer srv.Close()
	enableGame(t, app)
	cookie := checkinUser(t, app)

	start := startGame(t, app, cookie)
	dirs := repeatDirs(24)

	// 请求体里额外塞进一堆"我想要的结果",接口结构里根本没有这些字段。
	body := fmt.Sprintf(
		`{"session_id":%q,"base_moves":0,"moves":[%s],"score":999999,"quota":5000000,"highest_tile":65536,"reason":"ok"}`,
		start.SessionID, `"`+strings.Join(dirs, `","`)+`"`)
	rec := performJSON(gameRoutes(app), http.MethodPost, "/api/games/2048/submit", body, cookie)
	if rec.Code != http.StatusOK {
		t.Fatalf("结算失败: %d %s", rec.Code, rec.Body.String())
	}
	var resp struct {
		Data struct {
			Score       int64 `json:"score"`
			Quota       int64 `json:"quota"`
			HighestTile int   `json:"highest_tile"`
		} `json:"data"`
	}
	json.Unmarshal(rec.Body.Bytes(), &resp)

	// 服务端自己回放一遍,结果必须与接口返回一致,与请求体里的数字毫无关系。
	dirsTyped := make([]game2048.Direction, len(dirs))
	for i, d := range dirs {
		dirsTyped[i] = game2048.Direction(d)
	}
	want := game2048.Simulate(start.Seed, dirsTyped, game2048.MaxMoves)
	if resp.Data.Score != want.Score || resp.Data.HighestTile != want.HighestTile {
		t.Fatalf("服务端必须以回放结果为准:got %d/%d want %d/%d",
			resp.Data.Score, resp.Data.HighestTile, want.Score, want.HighestTile)
	}
	if resp.Data.Score == 999999 || resp.Data.Quota == 5000000 {
		t.Fatalf("请求体里的分数/额度绝不能被采纳")
	}

	var play model.GamePlay
	if err := db.First(&play).Error; err != nil {
		t.Fatalf("对局记录应当落库: %v", err)
	}
	if play.Score != want.Score {
		t.Fatalf("落库分数必须是回放结果:got %d want %d", play.Score, want.Score)
	}
}

// TestGameSubmitRejectsBadMoves 覆盖 AC2 的反面:非法方向与超长序列。
func TestGameSubmitRejectsBadMoves(t *testing.T) {
	app, srv, _ := checkinTestApp(t)
	defer srv.Close()
	enableGame(t, app)
	cookie := checkinUser(t, app)
	start := startGame(t, app, cookie)

	// 非法方向
	bad := movesJSON(start.SessionID, 0, []string{"left", "diagonal"})
	rec := performJSON(gameRoutes(app), http.MethodPost, "/api/games/2048/submit", bad, cookie)
	if rec.Code == http.StatusOK {
		t.Errorf("非法方向必须被拒,实际 %d %s", rec.Code, rec.Body.String())
	}

	// 超长序列
	tooMany := movesJSON(start.SessionID, 0, repeatDirs(game2048.MaxMoves+1))
	rec = performJSON(gameRoutes(app), http.MethodPost, "/api/games/2048/submit", tooMany, cookie)
	if rec.Code == http.StatusOK {
		t.Errorf("超过 %d 步必须被拒,实际 %d", game2048.MaxMoves, rec.Code)
	}
}

// TestGameSubmitRejectsOthersSession:拿别人的 session_id 提交必须失败。
func TestGameSubmitRejectsOthersSession(t *testing.T) {
	app, srv, _ := checkinTestApp(t)
	defer srv.Close()
	enableGame(t, app)
	cookie := checkinUser(t, app)
	start := startGame(t, app, cookie)

	other := model.User{LinuxDOID: "20002", LinuxDOName: "bob", TrustLevel: 2, Status: 1,
		NewapiUserID: int64p(43), NewapiUsername: "bob"}
	if err := app.DB.Create(&other).Error; err != nil {
		t.Fatalf("建用户: %v", err)
	}
	otherCookie := sessionCookie(t, app, other.ID, false)

	body := movesJSON(start.SessionID, 0, repeatDirs(6))
	rec := performJSON(gameRoutes(app), http.MethodPost, "/api/games/2048/submit", body, otherCookie)
	if rec.Code == http.StatusOK {
		t.Fatalf("用别人的会话结算必须被拒,实际 %d %s", rec.Code, rec.Body.String())
	}
}

// TestGameCheckpointMismatchReturns409 锁住令牌失配的 HTTP 状态码 ——
// 前端就是靠 e.status === 409 来决定重新对账的,改了这个码前端会静默失效。
func TestGameCheckpointMismatchReturns409(t *testing.T) {
	app, srv, _ := checkinTestApp(t)
	defer srv.Close()
	enableGame(t, app)
	cookie := checkinUser(t, app)
	start := startGame(t, app, cookie)

	body := movesJSON(start.SessionID, 99, repeatDirs(6))
	rec := performJSON(gameRoutes(app), http.MethodPost, "/api/games/2048/checkpoint", body, cookie)
	if rec.Code != http.StatusConflict {
		t.Fatalf("令牌失配必须返回 409,实际 %d %s", rec.Code, rec.Body.String())
	}
	rec = performJSON(gameRoutes(app), http.MethodPost, "/api/games/2048/submit", body, cookie)
	if rec.Code != http.StatusConflict {
		t.Fatalf("submit 的令牌失配同样要 409,实际 %d %s", rec.Code, rec.Body.String())
	}
}

// TestGameUnknownGameIs404:未知游戏返回 404 语义错误。
func TestGameUnknownGameIs404(t *testing.T) {
	app, srv, _ := checkinTestApp(t)
	defer srv.Close()
	cookie := checkinUser(t, app)

	rec := performJSON(gameRoutes(app), http.MethodPost, "/api/games/minesweeper/start", "", cookie)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("未知游戏应当 404,实际 %d %s", rec.Code, rec.Body.String())
	}
}

// TestGameRoutesRequireLogin:未登录访问一律 401。
func TestGameRoutesRequireLogin(t *testing.T) {
	app, srv, _ := checkinTestApp(t)
	defer srv.Close()

	routes := []struct{ method, path string }{
		{http.MethodGet, "/api/games"},
		{http.MethodGet, "/api/games/2048/status"},
		{http.MethodPost, "/api/games/2048/start"},
		{http.MethodPost, "/api/games/2048/checkpoint"},
		{http.MethodPost, "/api/games/2048/submit"},
		{http.MethodPost, "/api/games/2048/cancel"},
	}
	for _, rt := range routes {
		rec := perform(gameRoutes(app), rt.method, rt.path, nil)
		if rec.Code != http.StatusUnauthorized {
			t.Errorf("%s %s 未登录应当 401,实际 %d", rt.method, rt.path, rec.Code)
		}
	}
}

// TestGameLimiterIsSeparateFromCheckin 是 AC14:游戏接口用独立令牌桶,
// 打满一局不会把用户的签到额度吃光。
func TestGameLimiterIsSeparateFromCheckin(t *testing.T) {
	// 直接对令牌桶断言,不走 HTTP —— 桶是进程级单例,用独立 key 避免串扰。
	key := "test-user-ac14"
	// 把游戏的两个桶打到额度耗尽
	for i := 0; i < 200; i++ {
		middleware.GameLimiter.Allow(key)
		middleware.GameCheckpointLimiter.Allow(key)
	}
	if middleware.GameLimiter.Allow(key) {
		t.Fatalf("前置条件不成立:游戏桶应当已经耗尽")
	}
	if !middleware.PerUserLimiter.Allow(key) {
		t.Fatalf("游戏限流耗尽后,签到/活动的共享桶必须仍有额度(AC14)")
	}
}
