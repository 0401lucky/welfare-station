package service

import (
	"encoding/json"
	"errors"
	"regexp"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"welfare/model"
	"welfare/service/game2048"

	"gorm.io/gorm"
)

// ---- 夹具 ----

// gameTestRules 返回一份可控的 2048 规则:tiers 只有一档 tile=2,
// 于是任何一局(初始棋盘就有 2 或 4)都必然命中奖励档。想造「没够到奖励线」
// 就把档位换成 unreachableTile。
func gameTestRules(quota int64, dailyLimit int, userCap int64) GameRules {
	return GameRules{
		Enabled:         true,
		RewardType:      QuotaTypePermanent,
		DailyClaimLimit: dailyLimit,
		UserDailyCap:    userCap,
		CooldownSeconds: 0,
		Tiers:           []GameTier{{Tile: 2, Quota: quota}},
	}
}

// unreachableTile 是几步之内不可能合成出来的方块,用来制造 below_tier。
const unreachableTile = 65536

// seedGameConfig 把一份规则与预算写进 w_settings。绕过 SaveGameConfig 的校验是
// 有意的:用例要构造「预算只剩一份」这类极端配置。
func seedGameConfig(t *testing.T, db *gorm.DB, rules GameRules, budgets map[string]BudgetRule) {
	t.Helper()
	if budgets == nil {
		budgets = map[string]BudgetRule{}
	}
	cfg := &GameConfig{
		Timezone: "Asia/Shanghai",
		Games:    map[string]GameRules{game2048.GameType2048: rules},
		Budgets:  budgets,
	}
	raw, err := json.Marshal(cfg)
	if err != nil {
		t.Fatalf("marshal game config: %v", err)
	}
	if err := SetSetting(db, GameConfigKey, string(raw)); err != nil {
		t.Fatalf("seed game config: %v", err)
	}
}

// setupGameService 建库 + mock new-api + 一个已绑定的正常用户。
func setupGameService(t *testing.T) (*GameService, *mockNewAPI, *gorm.DB, *model.User) {
	t.Helper()
	grants, mock, db := setupGrantService(t)
	user := model.User{LinuxDOID: "g1", LinuxDOName: "gamer", TrustLevel: 2, Status: 1, NewapiUserID: int64Ptr(42)}
	if err := db.Create(&user).Error; err != nil {
		t.Fatalf("create user: %v", err)
	}
	return NewGameService(db, grants), mock, db, &user
}

// someMoves 是一段固定的操作序列,足以让棋盘动起来并合出更大的方块。
func someMoves(n int) []game2048.Direction {
	dirs := []game2048.Direction{
		game2048.DirectionLeft, game2048.DirectionUp,
		game2048.DirectionRight, game2048.DirectionDown,
	}
	out := make([]game2048.Direction, 0, n)
	for i := 0; i < n; i++ {
		out = append(out, dirs[i%len(dirs)])
	}
	return out
}

// playOnce 走一遍完整的「开局 → 结算」。
func playOnce(t *testing.T, svc *GameService, user *model.User, moves []game2048.Direction) *SettleResult {
	t.Helper()
	start, err := svc.Start(user, game2048.GameType2048)
	if err != nil {
		t.Fatalf("start: %v", err)
	}
	res, err := svc.Settle(user, game2048.GameType2048, start.SessionID, 0, moves)
	if err != nil {
		t.Fatalf("settle: %v", err)
	}
	return res
}

func countGrants(t *testing.T, db *gorm.DB, refID int64) int64 {
	t.Helper()
	var n int64
	if err := db.Model(&model.Grant{}).
		Where("type = ? AND ref_id = ?", GrantTypeGame, refID).Count(&n).Error; err != nil {
		t.Fatalf("count grants: %v", err)
	}
	return n
}

// ---- 用例 ----

// TestGameStartSeedIsLowercaseHex 锁死种子格式。hashToUnit 在 Go 按 rune 遍历、
// 在 JS 按 UTF-16 码元遍历,只有全 ASCII 两端才等价 —— 种子一旦混入非 ASCII,
// 前后端棋盘立刻分叉,全站结算失败。
func TestGameStartSeedIsLowercaseHex(t *testing.T) {
	svc, mock, db, user := setupGameService(t)
	defer mock.Close()
	seedGameConfig(t, db, gameTestRules(1000, 3, 100000), nil)

	hex32 := regexp.MustCompile(`^[0-9a-f]{32}$`)
	start, err := svc.Start(user, game2048.GameType2048)
	if err != nil {
		t.Fatalf("start: %v", err)
	}
	if !hex32.MatchString(start.Seed) {
		t.Errorf("seed 必须是 32 位小写 hex,实际 %q", start.Seed)
	}
	if !hex32.MatchString(start.SessionID) {
		t.Errorf("session_id 必须是 32 位小写 hex,实际 %q", start.SessionID)
	}
	// 初始棋盘由种子唯一决定,必须与引擎一致(前端拿到 seed 后自己也这么算)。
	want := game2048.CreateInitialGrid(start.Seed)
	if !gridsSame(start.InitialGrid, want) {
		t.Errorf("initial_grid 与 CreateInitialGrid(seed) 不一致:%v vs %v", start.InitialGrid, want)
	}
	if start.BaseScore != 0 || start.BaseMoves != 0 {
		t.Errorf("新局的基础分与步数应当是 0/0,实际 %d/%d", start.BaseScore, start.BaseMoves)
	}
}

// TestGameSettleIdempotent 覆盖 AC3:同一 session 连提两次,第二次返回首次结果,
// 流水仍只有一条,new-api 只被调用一次。
func TestGameSettleIdempotent(t *testing.T) {
	svc, mock, db, user := setupGameService(t)
	defer mock.Close()
	seedGameConfig(t, db, gameTestRules(1000, 3, 100000), nil)

	start, err := svc.Start(user, game2048.GameType2048)
	if err != nil {
		t.Fatalf("start: %v", err)
	}
	moves := someMoves(20)

	first, err := svc.Settle(user, game2048.GameType2048, start.SessionID, 0, moves)
	if err != nil {
		t.Fatalf("首次结算: %v", err)
	}
	if first.Play.Reason != GameReasonOK || first.Play.Quota != 1000 {
		t.Fatalf("首次结算应当发放 1000,实际 reason=%s quota=%d", first.Play.Reason, first.Play.Quota)
	}
	if first.Idempotent {
		t.Errorf("首次结算不应被标记为重复提交")
	}

	second, err := svc.Settle(user, game2048.GameType2048, start.SessionID, 0, moves)
	if err != nil {
		t.Fatalf("重复提交不应报错: %v", err)
	}
	if !second.Idempotent {
		t.Errorf("重复提交应当被标记为 Idempotent")
	}
	if second.Play.ID != first.Play.ID {
		t.Errorf("重复提交必须返回首次那条记录:got id=%d want %d", second.Play.ID, first.Play.ID)
	}
	if second.Play.Score != first.Play.Score || second.Play.Quota != first.Play.Quota {
		t.Errorf("重复提交返回的分数/额度必须与首次一致:%+v vs %+v", second.Play, first.Play)
	}
	if second.GrantStatus != GameGrantSuccess {
		t.Errorf("重复提交应当回报首次的发放状态 success,实际 %s", second.GrantStatus)
	}

	var plays int64
	db.Model(&model.GamePlay{}).Where("session_id = ?", start.SessionID).Count(&plays)
	if plays != 1 {
		t.Errorf("w_game_plays 应当只有 1 条,实际 %d", plays)
	}
	if n := countGrants(t, db, first.Play.ID); n != 1 {
		t.Errorf("w_grants 应当只有 1 条,实际 %d", n)
	}
	if got := atomic.LoadInt64(&mock.callCount); got != 1 {
		t.Errorf("new-api 只应被调用 1 次,实际 %d", got)
	}
}

// TestGameStartSingleSession 覆盖 AC4:已有进行中的局时再开被拒;
// 并发两个 start 恰好一个成功。
func TestGameStartSingleSession(t *testing.T) {
	svc, mock, db, user := setupGameService(t)
	defer mock.Close()
	seedGameConfig(t, db, gameTestRules(1000, 3, 100000), nil)

	if _, err := svc.Start(user, game2048.GameType2048); err != nil {
		t.Fatalf("首次开局: %v", err)
	}
	if _, err := svc.Start(user, game2048.GameType2048); !errors.Is(err, ErrGameSessionExists) {
		t.Fatalf("已有进行中的局时再开必须被拒,实际 err=%v", err)
	}
	// 放弃之后可以重新开(冷却只由对局记录推导,cancel 不写记录)。
	if err := svc.Cancel(user, game2048.GameType2048); err != nil {
		t.Fatalf("cancel: %v", err)
	}
	if _, err := svc.Start(user, game2048.GameType2048); err != nil {
		t.Fatalf("放弃后应当可以重新开局: %v", err)
	}
	if err := svc.Cancel(user, game2048.GameType2048); err != nil {
		t.Fatalf("cancel: %v", err)
	}

	// 并发开局:uk_user_game 保证恰好一个成功。
	const workers = 8
	var wg sync.WaitGroup
	var okCount int64
	errs := make([]error, workers)
	startGate := make(chan struct{})
	for i := 0; i < workers; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			<-startGate
			if _, err := svc.Start(user, game2048.GameType2048); err == nil {
				atomic.AddInt64(&okCount, 1)
			} else {
				errs[i] = err
			}
		}(i)
	}
	close(startGate)
	wg.Wait()

	if okCount != 1 {
		t.Fatalf("并发开局成功次数 = %d, want 恰好 1(errs=%v)", okCount, errs)
	}
	var sessions int64
	db.Model(&model.GameSession{}).Where("user_id = ?", user.ID).Count(&sessions)
	if sessions != 1 {
		t.Fatalf("w_game_sessions 应当只有 1 行,实际 %d", sessions)
	}
}

// TestGameStartClearsExpiredSession 验证过期的局不会把用户永久挡在门外。
func TestGameStartClearsExpiredSession(t *testing.T) {
	svc, mock, db, user := setupGameService(t)
	defer mock.Close()
	seedGameConfig(t, db, gameTestRules(1000, 3, 100000), nil)

	past := time.Now().Add(-time.Hour)
	if err := db.Create(&model.GameSession{
		ID: "expired0000000000000000000000000", UserID: user.ID, GameType: game2048.GameType2048,
		Seed: "aa", StartedAt: past.Add(-time.Hour), ExpiresAt: past, UpdatedAt: past,
	}).Error; err != nil {
		t.Fatalf("seed expired session: %v", err)
	}

	start, err := svc.Start(user, game2048.GameType2048)
	if err != nil {
		t.Fatalf("过期局应当被自动清掉: %v", err)
	}
	if start.SessionID == "expired0000000000000000000000000" {
		t.Fatalf("不该复用过期会话")
	}
	// 过期会话也不能再被结算。
	if _, err := svc.Settle(user, game2048.GameType2048, "expired0000000000000000000000000", 0, someMoves(3)); err == nil {
		t.Fatalf("过期会话不应能结算")
	}
}

// TestGameDailyClaimLimit 覆盖 AC5:limit=3,只有 reason=ok 的结算占次数。
//
// 用例顺序刻意排成 ok → below_tier → ok → ok → 第五局:若实现把 below_tier 也算进
// 次数,第四局就会被误判成 over_daily_limit,当场翻车。三局连发再补一局的排法
// 检测不出这个 bug(两种实现都会在第四局拒绝),故意不那么写。
func TestGameDailyClaimLimit(t *testing.T) {
	svc, mock, db, user := setupGameService(t)
	defer mock.Close()
	rules := gameTestRules(1000, 3, 100000)
	belowRules := gameTestRules(1000, 3, 100000)
	belowRules.Tiers = []GameTier{{Tile: unreachableTile, Quota: 1000}}

	seedGameConfig(t, db, rules, nil)
	if res := playOnce(t, svc, user, someMoves(10)); res.Play.Reason != GameReasonOK {
		t.Fatalf("第 1 局应当发放,实际 %s", res.Play.Reason)
	}

	// 穿插一局没够到奖励线的:不占次数。
	seedGameConfig(t, db, belowRules, nil)
	below := playOnce(t, svc, user, someMoves(10))
	if below.Play.Reason != GameReasonBelowTier || below.Play.Quota != 0 {
		t.Fatalf("未达档应当是 below_tier/0,实际 reason=%s quota=%d", below.Play.Reason, below.Play.Quota)
	}

	seedGameConfig(t, db, rules, nil)
	for i := 2; i <= 3; i++ {
		res := playOnce(t, svc, user, someMoves(10))
		if res.Play.Reason != GameReasonOK || res.Play.Quota != 1000 {
			t.Fatalf("第 %d 次领奖应当成功(below_tier 不占次数),实际 reason=%s quota=%d",
				i, res.Play.Reason, res.Play.Quota)
		}
	}

	fifth := playOnce(t, svc, user, someMoves(10))
	if fifth.Play.Reason != GameReasonOverDailyLimit {
		t.Fatalf("三次领奖用完后应当是 over_daily_limit,实际 %s", fifth.Play.Reason)
	}
	if fifth.Play.Quota != 0 {
		t.Errorf("次数用尽时不能发额度,实际 %d", fifth.Play.Quota)
	}
	if fifth.Grant != nil || fifth.GrantStatus != GameGrantNone {
		t.Errorf("次数用尽时不该产生流水,实际 grant=%v status=%s", fifth.Grant, fifth.GrantStatus)
	}
	if n := countGrants(t, db, fifth.Play.ID); n != 0 {
		t.Errorf("最后一局不该有流水,实际 %d 条", n)
	}
	// 对局记录仍要落库(玩得好但没奖励也要留痕)。
	var plays int64
	db.Model(&model.GamePlay{}).Where("user_id = ?", user.ID).Count(&plays)
	if plays != 5 {
		t.Errorf("五局都应当落库,实际 %d 条", plays)
	}
	var totalGrants int64
	db.Model(&model.Grant{}).Where("type = ?", GrantTypeGame).Count(&totalGrants)
	if totalGrants != 3 {
		t.Errorf("总共只应有 3 条流水,实际 %d", totalGrants)
	}
}

// TestGameUserDailyCap 覆盖 AC6:累计逼近个人上限后,下一笔按剩余额度部分发放,
// 余额归零后的下一局才返回 over_user_cap。
func TestGameUserDailyCap(t *testing.T) {
	svc, mock, db, user := setupGameService(t)
	defer mock.Close()
	// 上限 2500,单档 1000:前两局 1000+1000=2000 通过,第三局只发剩余 500。
	seedGameConfig(t, db, gameTestRules(1000, 10, 2500), nil)

	for i := 0; i < 2; i++ {
		res := playOnce(t, svc, user, someMoves(8))
		if res.Play.Reason != GameReasonOK || res.Play.Quota != 1000 {
			t.Fatalf("第 %d 局应当发放 1000,实际 reason=%s quota=%d", i+1, res.Play.Reason, res.Play.Quota)
		}
	}

	third := playOnce(t, svc, user, someMoves(8))
	if third.Play.Reason != GameReasonOK || third.Play.Quota != 500 {
		t.Fatalf("个人剩余 500 时应当部分发放,实际 reason=%s quota=%d", third.Play.Reason, third.Play.Quota)
	}
	if n := countGrants(t, db, third.Play.ID); n != 1 {
		t.Errorf("部分发放的那局应当有 1 条流水,实际 %d 条", n)
	}
	fourth := playOnce(t, svc, user, someMoves(8))
	if fourth.Play.Reason != GameReasonOverUserCap || fourth.Play.Quota != 0 {
		t.Fatalf("个人额度归零后应当 over_user_cap/0,实际 reason=%s quota=%d", fourth.Play.Reason, fourth.Play.Quota)
	}
	var sum int64
	db.Model(&model.GamePlay{}).Where("user_id = ?", user.ID).Select("COALESCE(SUM(quota),0)").Scan(&sum)
	if sum != 2500 {
		t.Errorf("今日累计发放应当停在 2500,实际 %d", sum)
	}
}

// TestGameSiteBudget 覆盖 AC7/AC8:预算池临界时按共同剩余额度部分发放,
// 两个池的 used 始终增加相同金额。
func TestGameSiteBudget(t *testing.T) {
	t.Run("game 池耗尽", func(t *testing.T) {
		svc, mock, db, user := setupGameService(t)
		defer mock.Close()
		// game 池只剩 500,单档奖励 1000。
		seedGameConfig(t, db, gameTestRules(1000, 10, 100000), map[string]BudgetRule{
			BudgetScopeGame:  {Enabled: true, Daily: 500},
			BudgetScopeTotal: {Enabled: false},
		})

		first := playOnce(t, svc, user, someMoves(8))
		if first.Play.Reason != GameReasonOK || first.Play.Quota != 500 {
			t.Fatalf("第一局应当按剩余预算发放 500,实际 reason=%s quota=%d", first.Play.Reason, first.Play.Quota)
		}
		second := playOnce(t, svc, user, someMoves(8))
		if second.Play.Reason != GameReasonOverSiteBudget || second.Play.Quota != 0 {
			t.Fatalf("预算耗尽应当是 over_site_budget/0,实际 reason=%s quota=%d",
				second.Play.Reason, second.Play.Quota)
		}
		// 游戏照常可玩、照常出成绩、照常记录(R3.5)。
		if second.Play.Score <= 0 || second.Play.Moves <= 0 {
			t.Errorf("预算发完也要照常记成绩,实际 score=%d moves=%d", second.Play.Score, second.Play.Moves)
		}
		today := TodayStr("Asia/Shanghai", time.Now())
		if got := budgetUsed(t, db, today, BudgetScopeGame); got != 500 {
			t.Errorf("game 池 used 应当恰好 500,实际 %d", got)
		}
	})

	t.Run("game 充足但 total 耗尽", func(t *testing.T) {
		svc, mock, db, user := setupGameService(t)
		defer mock.Close()
		// total 只剩 500,game 充足。
		seedGameConfig(t, db, gameTestRules(1000, 10, 100000), map[string]BudgetRule{
			BudgetScopeGame:  {Enabled: true, Daily: 100000},
			BudgetScopeTotal: {Enabled: true, Daily: 500},
		})

		if res := playOnce(t, svc, user, someMoves(8)); res.Play.Reason != GameReasonOK || res.Play.Quota != 500 {
			t.Fatalf("第一局应按 total 剩余发放 500,实际 reason=%s quota=%d", res.Play.Reason, res.Play.Quota)
		}
		second := playOnce(t, svc, user, someMoves(8))
		if second.Play.Reason != GameReasonOverSiteBudget || second.Play.Quota != 0 {
			t.Fatalf("total 池耗尽后应当 over_site_budget/0,实际 reason=%s quota=%d", second.Play.Reason, second.Play.Quota)
		}
		if n := countGrants(t, db, second.Play.ID); n != 0 {
			t.Errorf("被总池挡下的那局不该有流水,实际 %d 条", n)
		}

		today := TodayStr("Asia/Shanghai", time.Now())
		if got := budgetUsed(t, db, today, BudgetScopeGame); got != 500 {
			t.Fatalf("game 池 used 应当与实际发放一致,实际 %d", got)
		}
		if got := budgetUsed(t, db, today, BudgetScopeTotal); got != 500 {
			t.Fatalf("total 池 used 应当与实际发放一致,实际 %d", got)
		}
	})
}

// TestGameGrantFailureKeepsPlay 覆盖 AC11:外呼失败时对局记录保留、流水为 failed、
// 不产生第二笔发放,用户拿到可解释的错误。
func TestGameGrantFailureKeepsPlay(t *testing.T) {
	svc, mock, db, user := setupGameService(t)
	defer mock.Close()
	seedGameConfig(t, db, gameTestRules(1000, 3, 100000), nil)
	mock.failNext = 1 // 第一次外呼失败

	start, err := svc.Start(user, game2048.GameType2048)
	if err != nil {
		t.Fatalf("start: %v", err)
	}
	res, err := svc.Settle(user, game2048.GameType2048, start.SessionID, 0, someMoves(12))
	if err != nil {
		t.Fatalf("外呼失败不应让结算整体失败: %v", err)
	}
	if res.OutErr == nil {
		t.Fatalf("外呼失败必须回报给调用方,好让前端提示「稍后自动补发」")
	}
	if res.GrantStatus != GameGrantFailed {
		t.Errorf("grant_status 应当是 failed,实际 %s", res.GrantStatus)
	}

	var play model.GamePlay
	if err := db.First(&play, res.Play.ID).Error; err != nil {
		t.Fatalf("对局记录必须保留: %v", err)
	}
	if play.Quota != 1000 || play.Reason != GameReasonOK {
		t.Errorf("对局记录应当保留 ok/1000,实际 reason=%s quota=%d", play.Reason, play.Quota)
	}

	var g model.Grant
	if err := db.Where("type = ? AND ref_id = ?", GrantTypeGame, play.ID).First(&g).Error; err != nil {
		t.Fatalf("load grant: %v", err)
	}
	if g.Status != GrantStatusFailed || g.Error == "" {
		t.Errorf("流水应当是 failed 且带错误信息,实际 status=%s error=%q", g.Status, g.Error)
	}
	if g.QuotaType != QuotaTypePermanent {
		t.Errorf("额度类型必须冻结在流水里,实际 %q", g.QuotaType)
	}
	if n := countGrants(t, db, play.ID); n != 1 {
		t.Errorf("失败也只能有一条流水,实际 %d", n)
	}

	// 重复提交不得再次外呼(否则失败的局会被重放成双发)。
	callsBefore := atomic.LoadInt64(&mock.callCount)
	again, err := svc.Settle(user, game2048.GameType2048, start.SessionID, 0, someMoves(12))
	if err != nil {
		t.Fatalf("重复提交: %v", err)
	}
	if !again.Idempotent || again.GrantStatus != GameGrantFailed {
		t.Errorf("重放应当原样回报首次的 failed,实际 idempotent=%v status=%s", again.Idempotent, again.GrantStatus)
	}
	if got := atomic.LoadInt64(&mock.callCount); got != callsBefore {
		t.Errorf("重放不能再次外呼,调用次数 %d → %d", callsBefore, got)
	}
	if n := countGrants(t, db, play.ID); n != 1 {
		t.Errorf("重放后流水仍应只有 1 条,实际 %d", n)
	}
}

// TestGameRewardTypeFrozenInGrant 验证限时额度模式下流水记录的是 temporary,
// 且外呼打到限时接口。
func TestGameRewardTypeFrozenInGrant(t *testing.T) {
	svc, mock, db, user := setupGameService(t)
	defer mock.Close()
	rules := gameTestRules(1000, 3, 100000)
	rules.RewardType = QuotaTypeTemporary
	seedGameConfig(t, db, rules, nil)

	res := playOnce(t, svc, user, someMoves(6))
	if res.OutErr != nil {
		t.Fatalf("外呼不应失败: %v", res.OutErr)
	}
	var g model.Grant
	if err := db.Where("type = ? AND ref_id = ?", GrantTypeGame, res.Play.ID).First(&g).Error; err != nil {
		t.Fatalf("load grant: %v", err)
	}
	if g.QuotaType != QuotaTypeTemporary {
		t.Errorf("流水应当冻结 temporary,实际 %q", g.QuotaType)
	}
	if got := atomic.LoadInt64(&mock.tempCalls); got != 1 {
		t.Errorf("应当打到 temporary_quota 一次,实际 %d", got)
	}
	if res.Play.QuotaType != QuotaTypeTemporary {
		t.Errorf("对局记录也应记下额度类型,实际 %q", res.Play.QuotaType)
	}
}

// TestGameCheckpointTamperedPayloadFallsBack 覆盖存档自校验:非法 payload 一律
// 回退到种子初始局,而不是报错或原样采信。
func TestGameCheckpointTamperedPayloadFallsBack(t *testing.T) {
	cases := []struct {
		name    string
		payload string
	}{
		{"含非 2 的幂的方块", `{"grid":[[3,0,0,0,0],[0,0,0,0,0],[0,0,0,0,0],[0,0,0,0,0],[0,0,0,0,0]],"score":999999,"moves_applied":5,"moves_submitted":5}`},
		{"尺寸不是 5x5", `{"grid":[[2,0,0,0],[0,0,0,0],[0,0,0,0],[0,0,0,0]],"score":999999,"moves_applied":5,"moves_submitted":5}`},
		{"分数为负", `{"grid":[[2,0,0,0,0],[0,0,0,0,0],[0,0,0,0,0],[0,0,0,0,0],[0,0,0,0,0]],"score":-1,"moves_applied":0,"moves_submitted":0}`},
		{"已应用步数多于已提交步数", `{"grid":[[2,0,0,0,0],[0,0,0,0,0],[0,0,0,0,0],[0,0,0,0,0],[0,0,0,0,0]],"score":10,"moves_applied":9,"moves_submitted":1}`},
		{"根本不是 JSON", `not-json`},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			svc, mock, db, user := setupGameService(t)
			defer mock.Close()
			seedGameConfig(t, db, gameTestRules(1000, 3, 100000), nil)

			start, err := svc.Start(user, game2048.GameType2048)
			if err != nil {
				t.Fatalf("start: %v", err)
			}
			if err := db.Model(&model.GameSession{}).Where("id = ?", start.SessionID).
				Update("payload", tc.payload).Error; err != nil {
				t.Fatalf("篡改 payload: %v", err)
			}

			// 与「从未存过档」的同一局跑同一段 moves,结果必须完全一致。
			moves := someMoves(15)
			got, err := svc.Settle(user, game2048.GameType2048, start.SessionID, 0, moves)
			if err != nil {
				t.Fatalf("篡改后的存档应当被静默回退而不是报错: %v", err)
			}
			want := game2048.Simulate(start.Seed, moves, game2048.MaxMoves)
			if !want.OK {
				t.Fatalf("参照回放失败: %s", want.Message)
			}
			if got.Play.Score != want.Score {
				t.Errorf("分数应当回退到从零回放的结果 %d,实际 %d(采信了伪造存档)", want.Score, got.Play.Score)
			}
			if got.Play.Moves != want.MovesApplied {
				t.Errorf("步数应当是 %d,实际 %d", want.MovesApplied, got.Play.Moves)
			}
			if got.Play.HighestTile != want.HighestTile {
				t.Errorf("最高方块应当是 %d,实际 %d", want.HighestTile, got.Play.HighestTile)
			}
		})
	}
}

// TestGameCheckpointThenSettle 覆盖 AC12 的服务端一半:存档后续算的结果,
// 必须与一次性提交整段 moves 完全一致。
func TestGameCheckpointThenSettle(t *testing.T) {
	svc, mock, db, user := setupGameService(t)
	defer mock.Close()
	seedGameConfig(t, db, gameTestRules(1000, 3, 100000), nil)

	start, err := svc.Start(user, game2048.GameType2048)
	if err != nil {
		t.Fatalf("start: %v", err)
	}
	all := someMoves(40)
	head, tail := all[:24], all[24:]

	cp, err := svc.Checkpoint(user, game2048.GameType2048, start.SessionID, 0, head)
	if err != nil {
		t.Fatalf("checkpoint: %v", err)
	}
	// 存档不结算、不发额度。
	var plays, grants int64
	db.Model(&model.GamePlay{}).Count(&plays)
	db.Model(&model.Grant{}).Count(&grants)
	if plays != 0 || grants != 0 {
		t.Fatalf("checkpoint 不能写对局记录或流水,实际 %d/%d", plays, grants)
	}
	if cp.ExpiresAt.Before(start.ExpiresAt) {
		t.Errorf("checkpoint 应当续期,%v 早于 %v", cp.ExpiresAt, start.ExpiresAt)
	}
	// Status 要能把存档还原出来(断线恢复)。
	st, err := svc.Status(user, game2048.GameType2048)
	if err != nil {
		t.Fatalf("status: %v", err)
	}
	if st.ActiveSession == nil {
		t.Fatalf("status 应当返回活跃局")
	}
	if st.ActiveSession.BaseScore != cp.Score || st.ActiveSession.BaseMoves != cp.MovesApplied {
		t.Errorf("断线恢复的基础分/步数不一致:%d/%d vs %d/%d",
			st.ActiveSession.BaseScore, st.ActiveSession.BaseMoves, cp.Score, cp.MovesApplied)
	}
	if !gridsSame(st.ActiveSession.Grid, cp.Grid) {
		t.Errorf("断线恢复的棋盘与存档不一致")
	}

	res, err := svc.Settle(user, game2048.GameType2048, start.SessionID, cp.MovesApplied, tail)
	if err != nil {
		t.Fatalf("settle: %v", err)
	}
	want := game2048.Simulate(start.Seed, all, game2048.MaxMoves)
	if res.Play.Score != want.Score || res.Play.Moves != want.MovesApplied || res.Play.HighestTile != want.HighestTile {
		t.Fatalf("分段回放必须等于整段回放:got %d/%d/%d want %d/%d/%d",
			res.Play.Score, res.Play.Moves, res.Play.HighestTile,
			want.Score, want.MovesApplied, want.HighestTile)
	}
}

// TestGameAntiCheatBaseline 覆盖 AC2 的服务端一半:
//   - 分数只来自服务端回放,伪造不同的 moves 只会得到不同的(而非期望的)分数;
//   - 全是无效方向的序列一步都不算,分数为 0;
//   - 非法方向与超长序列被拒;
//   - 别人的 session 不能提交。
func TestGameAntiCheatBaseline(t *testing.T) {
	svc, mock, db, user := setupGameService(t)
	defer mock.Close()
	seedGameConfig(t, db, gameTestRules(1000, 10, 1000000), nil)

	// 同一种子、两组不同 moves → 不同分数(分数由回放决定,不由提交者决定)。
	s1, _ := svc.Start(user, game2048.GameType2048)
	seed := s1.Seed
	r1, err := svc.Settle(user, game2048.GameType2048, s1.SessionID, 0, someMoves(30))
	if err != nil {
		t.Fatalf("settle 1: %v", err)
	}
	alt := make([]game2048.Direction, 0, 30)
	for i := 0; i < 30; i++ {
		alt = append(alt, game2048.DirectionLeft, game2048.DirectionUp)
	}
	sim := game2048.Simulate(seed, alt, game2048.MaxMoves)
	if sim.Score == r1.Play.Score {
		t.Skip("两组序列在该种子下恰好同分,换个种子再看(非常罕见)")
	}

	// 一整局全推同一个方向直到推不动:后续步全是无效移动,不消耗 spawn 序号。
	s2, err := svc.Start(user, game2048.GameType2048)
	if err != nil {
		t.Fatalf("start 2: %v", err)
	}
	dead := make([]game2048.Direction, 200)
	for i := range dead {
		dead[i] = game2048.DirectionLeft
	}
	deadWant := game2048.Simulate(s2.Seed, dead, game2048.MaxMoves)
	r2, err := svc.Settle(user, game2048.GameType2048, s2.SessionID, 0, dead)
	if err != nil {
		t.Fatalf("settle 2: %v", err)
	}
	if r2.Play.Score != deadWant.Score || r2.Play.Moves != deadWant.MovesApplied {
		t.Errorf("无效步不该被计入:got %d/%d want %d/%d",
			r2.Play.Score, r2.Play.Moves, deadWant.Score, deadWant.MovesApplied)
	}
	if r2.Play.Moves >= len(dead) {
		t.Errorf("200 步同向必然有大量无效步,movesApplied 不应等于提交步数 %d", r2.Play.Moves)
	}

	// 非法方向被拒,且不留任何痕迹。
	s3, err := svc.Start(user, game2048.GameType2048)
	if err != nil {
		t.Fatalf("start 3: %v", err)
	}
	playsBefore := int64(0)
	db.Model(&model.GamePlay{}).Count(&playsBefore)
	if _, err := svc.Settle(user, game2048.GameType2048, s3.SessionID, 0,
		[]game2048.Direction{game2048.DirectionLeft, "diagonal"}); err == nil {
		t.Errorf("非法方向必须被拒")
	}
	// 超长序列被拒。
	tooMany := make([]game2048.Direction, game2048.MaxMoves+1)
	for i := range tooMany {
		tooMany[i] = game2048.DirectionLeft
	}
	if _, err := svc.Settle(user, game2048.GameType2048, s3.SessionID, 0, tooMany); err == nil {
		t.Errorf("超过 %d 步必须被拒", game2048.MaxMoves)
	}
	var playsAfter int64
	db.Model(&model.GamePlay{}).Count(&playsAfter)
	if playsAfter != playsBefore {
		t.Errorf("被拒的提交不能落对局记录,%d → %d", playsBefore, playsAfter)
	}

	// 别人的 session 提交不了,且按「会话不存在」回话,不泄露归属。
	other := model.User{LinuxDOID: "g2", LinuxDOName: "other", Status: 1, NewapiUserID: int64Ptr(43)}
	if err := db.Create(&other).Error; err != nil {
		t.Fatalf("create other: %v", err)
	}
	if _, err := svc.Settle(&other, game2048.GameType2048, s3.SessionID, 0, someMoves(4)); !errors.Is(err, ErrGameSessionGone) {
		t.Errorf("用别人的 session 结算应当报「会话不存在」,实际 %v", err)
	}
	if _, err := svc.Checkpoint(&other, game2048.GameType2048, s3.SessionID, 0, someMoves(4)); !errors.Is(err, ErrGameSessionGone) {
		t.Errorf("用别人的 session 存档应当报「会话不存在」,实际 %v", err)
	}
}

// TestGameCooldownAndDisabled 覆盖冷却与关停:冷却期内开局被拒并带剩余秒数;
// 关停后开局被拒,但已开的局仍能结算(记 disabled、不发额度)。
func TestGameCooldownAndDisabled(t *testing.T) {
	svc, mock, db, user := setupGameService(t)
	defer mock.Close()
	rules := gameTestRules(1000, 10, 100000)
	rules.CooldownSeconds = 60
	seedGameConfig(t, db, rules, nil)

	playOnce(t, svc, user, someMoves(6))
	_, err := svc.Start(user, game2048.GameType2048)
	var cd *GameCooldownError
	if !errors.As(err, &cd) {
		t.Fatalf("冷却期内开局应当返回 GameCooldownError,实际 %v", err)
	}
	if cd.Remaining <= 0 || cd.Remaining > 60 {
		t.Errorf("剩余秒数应当落在 (0,60],实际 %d", cd.Remaining)
	}
	st, err := svc.Status(user, game2048.GameType2048)
	if err != nil {
		t.Fatalf("status: %v", err)
	}
	if st.CooldownRemaining <= 0 {
		t.Errorf("status 也要给出冷却剩余,实际 %d", st.CooldownRemaining)
	}
	if st.TodayClaims != 1 || st.TodayQuota != 1000 {
		t.Errorf("status 今日次数/额度 = %d/%d, want 1/1000", st.TodayClaims, st.TodayQuota)
	}

	// 关停:已开的局仍可结算,记 disabled 且不发额度。
	rules.CooldownSeconds = 0
	seedGameConfig(t, db, rules, nil)
	start, err := svc.Start(user, game2048.GameType2048)
	if err != nil {
		t.Fatalf("start: %v", err)
	}
	rules.Enabled = false
	seedGameConfig(t, db, rules, nil)
	if _, err := svc.Start(user, game2048.GameType2048); !errors.Is(err, ErrGameDisabled) {
		t.Errorf("关停后开局应当被拒,实际 %v", err)
	}
	res, err := svc.Settle(user, game2048.GameType2048, start.SessionID, 0, someMoves(6))
	if err != nil {
		t.Fatalf("关停后已开的局仍应能结算: %v", err)
	}
	if res.Play.Reason != GameReasonDisabled || res.Play.Quota != 0 {
		t.Errorf("关停后结算应当是 disabled/0,实际 reason=%s quota=%d", res.Play.Reason, res.Play.Quota)
	}
}

// TestGameUnsupportedType 验证未实现引擎的游戏一律被拒。
func TestGameUnsupportedType(t *testing.T) {
	svc, mock, db, user := setupGameService(t)
	defer mock.Close()
	seedGameConfig(t, db, gameTestRules(1000, 3, 100000), nil)

	if _, err := svc.Start(user, "minesweeper"); !errors.Is(err, ErrGameNotSupported) {
		t.Errorf("Start 未知游戏应当被拒,实际 %v", err)
	}
	if _, err := svc.Settle(user, "minesweeper", "x", 0, someMoves(2)); !errors.Is(err, ErrGameNotSupported) {
		t.Errorf("Settle 未知游戏应当被拒,实际 %v", err)
	}
	if _, err := svc.Checkpoint(user, "minesweeper", "x", 0, someMoves(2)); !errors.Is(err, ErrGameNotSupported) {
		t.Errorf("Checkpoint 未知游戏应当被拒,实际 %v", err)
	}
	if err := svc.Cancel(user, "minesweeper"); !errors.Is(err, ErrGameNotSupported) {
		t.Errorf("Cancel 未知游戏应当被拒,实际 %v", err)
	}
	if !IsSupportedGame(game2048.GameType2048) {
		t.Errorf("2048 必须是受支持的游戏")
	}
}

// TestGameSettleUnknownSession 验证既没有会话也没有对局记录时报「会话不存在」。
func TestGameSettleUnknownSession(t *testing.T) {
	svc, mock, db, user := setupGameService(t)
	defer mock.Close()
	seedGameConfig(t, db, gameTestRules(1000, 3, 100000), nil)

	_, err := svc.Settle(user, game2048.GameType2048, "00000000000000000000000000000000", 0, someMoves(3))
	if !errors.Is(err, ErrGameSessionGone) {
		t.Fatalf("未知 session 应当报 ErrGameSessionGone,实际 %v", err)
	}
}

// TestGameZeroQuotaTierDoesNotBurnClaim 验证 quota=0 的档不算「领到奖励」:
// 站长把某档配成 0 时,玩家不该因此白白烧掉一次领奖机会。
func TestGameZeroQuotaTierDoesNotBurnClaim(t *testing.T) {
	svc, mock, db, user := setupGameService(t)
	defer mock.Close()
	rules := gameTestRules(0, 1, 100000) // 单档 quota=0,每日只有 1 次机会
	seedGameConfig(t, db, rules, nil)

	res := playOnce(t, svc, user, someMoves(6))
	if res.Play.Reason != GameReasonBelowTier {
		t.Fatalf("quota=0 的档应当按 below_tier 处理,实际 %s", res.Play.Reason)
	}
	// 机会没被烧掉:把奖励改回正数后仍能领到。
	seedGameConfig(t, db, gameTestRules(1000, 1, 100000), nil)
	next := playOnce(t, svc, user, someMoves(6))
	if next.Play.Reason != GameReasonOK || next.Play.Quota != 1000 {
		t.Fatalf("上一局不该占用次数,实际 reason=%s quota=%d", next.Play.Reason, next.Play.Quota)
	}
}

// TestGameSettleRequiresBinding 验证未绑定 new-api 时结算被拒,且会话保留 ——
// 用户补绑之后还能把这局结算掉。
func TestGameSettleRequiresBinding(t *testing.T) {
	svc, mock, db, user := setupGameService(t)
	defer mock.Close()
	seedGameConfig(t, db, gameTestRules(1000, 3, 100000), nil)

	start, err := svc.Start(user, game2048.GameType2048)
	if err != nil {
		t.Fatalf("start: %v", err)
	}
	unbound := *user
	unbound.NewapiUserID = nil
	if _, err := svc.Settle(&unbound, game2048.GameType2048, start.SessionID, 0, someMoves(6)); !errors.Is(err, ErrNotBound) {
		t.Fatalf("未绑定应当报 ErrNotBound,实际 %v", err)
	}
	var sessions int64
	db.Model(&model.GameSession{}).Where("id = ?", start.SessionID).Count(&sessions)
	if sessions != 1 {
		t.Errorf("被拒的结算不能删掉会话,实际剩 %d 行", sessions)
	}
	if res, err := svc.Settle(user, game2048.GameType2048, start.SessionID, 0, someMoves(6)); err != nil {
		t.Errorf("绑定恢复后应当能正常结算: %v", err)
	} else if res.Play.Reason != GameReasonOK {
		t.Errorf("绑定恢复后应当正常发放,实际 %s", res.Play.Reason)
	}
}

// TestGameBudgetRollbackKeepsNoLeftovers 单独盯住「total 被拒 → 整个事务回滚 →
// 以 reward=0 重跑」这条路径的副作用:重跑只能留下一条对局记录,预算表不能多出账。
func TestGameBudgetRollbackKeepsNoLeftovers(t *testing.T) {
	svc, mock, db, user := setupGameService(t)
	defer mock.Close()
	seedGameConfig(t, db, gameTestRules(1000, 10, 100000), map[string]BudgetRule{
		BudgetScopeGame:  {Enabled: true, Daily: 100000},
		BudgetScopeTotal: {Enabled: true, Daily: 0}, // 总池开着但一分钱没有
	})

	res := playOnce(t, svc, user, someMoves(10))
	if res.Play.Reason != GameReasonOverSiteBudget {
		t.Fatalf("总池为 0 时应当 over_site_budget,实际 %s", res.Play.Reason)
	}
	var plays int64
	db.Model(&model.GamePlay{}).Where("user_id = ?", user.ID).Count(&plays)
	if plays != 1 {
		t.Fatalf("回滚重跑只能留下 1 条对局记录,实际 %d", plays)
	}
	today := TodayStr("Asia/Shanghai", time.Now())
	if got := budgetUsed(t, db, today, BudgetScopeGame); got != 0 {
		t.Errorf("没发额度时 game 池不该有任何账,实际 used=%d", got)
	}
	if got := budgetUsed(t, db, today, BudgetScopeTotal); got != 0 {
		t.Errorf("没发额度时 total 池不该有任何账,实际 used=%d", got)
	}
	// 会话必须已经被删掉(重跑那一轮提交了)。
	var sessions int64
	db.Model(&model.GameSession{}).Where("user_id = ?", user.ID).Count(&sessions)
	if sessions != 0 {
		t.Errorf("结算完会话应当已删除,实际剩 %d 行", sessions)
	}
}

// gridsSame 比较两个棋盘。
func gridsSame(a, b game2048.Grid) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if len(a[i]) != len(b[i]) {
			return false
		}
		for j := range a[i] {
			if a[i][j] != b[i][j] {
				return false
			}
		}
	}
	return true
}

// TestGameNormalizeMovesAcceptsNil 验证 moves 为 null 的提交按「本段零步」处理:
// 已经 checkpoint 完的最后一次 submit 就是这种形状,不该整局作废。
func TestGameNormalizeMovesAcceptsNil(t *testing.T) {
	got, err := normalizeGameMoves(nil)
	if err != nil {
		t.Fatalf("nil moves 应当被当作空序列: %v", err)
	}
	if len(got) != 0 {
		t.Fatalf("应当得到空序列,实际 %v", got)
	}
	if _, err := normalizeGameMoves([]game2048.Direction{"up", "sideways"}); err == nil ||
		!strings.Contains(err.Error(), "方向") {
		t.Fatalf("非法方向应当报「方向无效」,实际 %v", err)
	}
}

// TestGameBaseMovesTokenRejectsReplay 锁住 base_moves 乐观令牌。
//
// 令牌挡的不是作弊(攻击者本来就能自由构造 moves,服务端回放照样算真分),
// 挡的是**重放**:前端在 checkpoint 在途时又拿同一段 moves 发 submit,服务端
// 会把这段算两次,分数凭空变高且无从察觉。没有令牌时,正确性完全押在
// 「前端必须 await 在途 checkpoint」这条自律上。
func TestGameBaseMovesTokenRejectsReplay(t *testing.T) {
	svc, mock, db, user := setupGameService(t)
	defer mock.Close()
	seedGameConfig(t, db, gameTestRules(1000, 3, 100000), nil)

	start, err := svc.Start(user, game2048.GameType2048)
	if err != nil {
		t.Fatalf("start: %v", err)
	}
	head := someMoves(24)

	// 存档推进到 cp.MovesApplied。
	cp, err := svc.Checkpoint(user, game2048.GameType2048, start.SessionID, 0, head)
	if err != nil {
		t.Fatalf("checkpoint: %v", err)
	}
	if cp.MovesApplied == 0 {
		t.Fatalf("这组 moves 应当至少推动棋盘一次")
	}

	// 关键断言:拿旧令牌(0)重发同一段 head —— 正是「重放两次」的形态,必须被拒。
	if _, err := svc.Settle(user, game2048.GameType2048, start.SessionID, 0, head); !errors.Is(err, ErrGameCheckpointMismatch) {
		t.Fatalf("旧 base_moves 重发同一段必须被拒,实际 err=%v", err)
	}

	// 被拒之后会话与存档一个字节都不能变:不写对局记录、不产流水、存档还在原处。
	var plays, grants int64
	db.Model(&model.GamePlay{}).Count(&plays)
	db.Model(&model.Grant{}).Count(&grants)
	if plays != 0 || grants != 0 {
		t.Fatalf("令牌失配不得产生任何副作用,实际 plays=%d grants=%d", plays, grants)
	}
	st, err := svc.Status(user, game2048.GameType2048)
	if err != nil {
		t.Fatalf("status: %v", err)
	}
	if st.ActiveSession == nil {
		t.Fatalf("令牌失配不得删除会话")
	}
	if st.ActiveSession.BaseMoves != cp.MovesApplied || st.ActiveSession.BaseScore != cp.Score {
		t.Fatalf("令牌失配不得改动存档:got %d/%d want %d/%d",
			st.ActiveSession.BaseMoves, st.ActiveSession.BaseScore, cp.MovesApplied, cp.Score)
	}

	// 带正确令牌继续结算,分数必须等于「整段一次性回放」的结果。
	tail := someMoves(16)
	res, err := svc.Settle(user, game2048.GameType2048, start.SessionID, cp.MovesApplied, tail)
	if err != nil {
		t.Fatalf("正确令牌的结算不该失败: %v", err)
	}
	want := game2048.Simulate(start.Seed, append(append([]game2048.Direction{}, head...), tail...), game2048.MaxMoves)
	if res.Play.Score != want.Score || res.Play.Moves != want.MovesApplied {
		t.Fatalf("分段回放必须等于整段回放:got %d/%d want %d/%d",
			res.Play.Score, res.Play.Moves, want.Score, want.MovesApplied)
	}
}

// TestGameCheckpointTokenMismatch:checkpoint 路径同样受令牌保护。
func TestGameCheckpointTokenMismatch(t *testing.T) {
	svc, mock, db, user := setupGameService(t)
	defer mock.Close()
	seedGameConfig(t, db, gameTestRules(1000, 3, 100000), nil)

	start, err := svc.Start(user, game2048.GameType2048)
	if err != nil {
		t.Fatalf("start: %v", err)
	}
	if _, err := svc.Checkpoint(user, game2048.GameType2048, start.SessionID, 7, someMoves(4)); !errors.Is(err, ErrGameCheckpointMismatch) {
		t.Fatalf("凭空的 base_moves 必须被拒,实际 err=%v", err)
	}
	// 存档没被推进,用 0 仍然可以正常存档。
	if _, err := svc.Checkpoint(user, game2048.GameType2048, start.SessionID, 0, someMoves(4)); err != nil {
		t.Fatalf("失配之后存档状态应保持原样,正确令牌应当成功: %v", err)
	}
}
