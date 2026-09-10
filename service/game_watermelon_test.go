package service

import (
	"errors"
	"reflect"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"welfare/model"
	"welfare/service/game2048"
	"welfare/service/gamewatermelon"

	"gorm.io/gorm"
)

const watermelonTestSeed = "0123456789abcdef0123456789abcdef"

func seedWatermelonConfig(t *testing.T, db *gorm.DB, rules GameRules, budgets map[string]BudgetRule) {
	t.Helper()
	cfg, err := GetGameConfig(db)
	if err != nil {
		t.Fatal(err)
	}
	cfg.Games[gamewatermelon.GameType] = rules
	if budgets != nil {
		cfg.Budgets = budgets
	}
	if err := SaveGameConfig(db, cfg, testMaxGrantQuota); err != nil {
		t.Fatal(err)
	}
}
func watermelonRules(quota int64) GameRules {
	r := DefaultWatermelonRules()
	r.Tiers = []GameTier{{Tile: 4, Quota: quota}}
	r.CooldownSeconds = 0
	return r
}
func startWatermelonTest(t *testing.T, svc *GameService, user *model.User) *StartResult {
	t.Helper()
	start, err := svc.Start(user, gamewatermelon.GameType)
	if err != nil {
		t.Fatal(err)
	}
	// Deterministic test clock/seed only: production always uses crypto/rand and
	// real elapsed time. All score/reward metrics below still come from replay.
	if err := svc.db.Model(&model.GameSession{}).Where("id = ?", start.SessionID).
		Updates(map[string]any{"seed": watermelonTestSeed, "started_at": time.Now().Add(-10 * time.Minute)}).Error; err != nil {
		t.Fatal(err)
	}
	start.Seed = watermelonTestSeed
	start.WatermelonState = watermelonState(gamewatermelon.Initial(watermelonTestSeed))
	return start
}
func watermelonDrops(from, to int) []gamewatermelon.Drop {
	drops := []gamewatermelon.Drop{}
	for tick := 0; tick <= to; tick += 91 {
		if tick >= from {
			drops = append(drops, gamewatermelon.Drop{Tick: tick, X: 180})
		}
	}
	return drops
}
func watermelonRequest(id string) WatermelonSegment {
	return WatermelonSegment{SessionID: id, ToTick: 600, Drops: watermelonDrops(0, 600)}
}
func assertNoWatermelonWrites(t *testing.T, db *gorm.DB, id string, before model.GameSession) {
	t.Helper()
	var after model.GameSession
	if err := db.First(&after, "id = ?", id).Error; err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(before, after) {
		t.Fatal("rejected request changed session payload/expiry/tokens")
	}
	for _, m := range []any{&model.GamePlay{}, &model.Grant{}, &model.DailyBudget{}} {
		var count int64
		if err := db.Model(m).Count(&count).Error; err != nil {
			t.Fatal(err)
		}
		if count != 0 {
			t.Fatalf("rejected replay wrote %T: %d", m, count)
		}
	}
}

func TestWatermelonReplayCheckpointSettlementAndIdempotency(t *testing.T) {
	svc, mock, db, user := setupGameService(t)
	defer mock.Close()
	seedWatermelonConfig(t, db, watermelonRules(1000), nil)
	start := startWatermelonTest(t, svc, user)
	if start.EngineVersion != gamewatermelon.Version || start.TickRate != 120 || start.BaseTick == nil || *start.BaseTick != 0 || start.State.Highest != -1 || start.Limits.MaxSegmentTicks != 600 {
		t.Fatalf("start contract: %+v", start)
	}
	checkpoint := WatermelonSegment{SessionID: start.SessionID, ToTick: 311, Drops: watermelonDrops(0, 311)}
	cp, err := svc.CheckpointWatermelon(user, checkpoint)
	if err != nil {
		t.Fatal(err)
	}
	if *cp.BaseTick != 311 || cp.BaseMoves != 4 || cp.State.Drops != 4 {
		t.Fatalf("checkpoint tokens: %+v", cp)
	}
	st, err := svc.Status(user, gamewatermelon.GameType)
	if err != nil {
		t.Fatal(err)
	}
	if st.ActiveSession == nil || !reflect.DeepEqual(st.ActiveSession.State, cp.State) || st.ActiveSession.BaseMoves != 4 || st.EngineVersion != gamewatermelon.Version {
		t.Fatalf("status recovery: %+v", st)
	}
	final := WatermelonSegment{SessionID: start.SessionID, BaseTick: 311, BaseMoves: 4, ToTick: 600, Drops: watermelonDrops(312, 600)}
	want, err := gamewatermelon.Replay(start.Seed, *cp.State, 600, final.Drops)
	if err != nil {
		t.Fatal(err)
	}
	res, err := svc.SettleWatermelon(user, final)
	if err != nil {
		t.Fatal(err)
	}
	if res.Play.Score != want.Score || res.Play.HighestTile != want.HighestTile() || res.Play.Moves != 7 || res.Play.Reason != GameReasonOK || res.Play.Quota != 1000 || res.GrantStatus != GameGrantSuccess {
		t.Fatalf("real replay payout: %+v", res)
	}
	changed := watermelonRules(9000)
	changed.RewardType = QuotaTypeTemporary
	seedWatermelonConfig(t, db, changed, nil)
	duplicate, err := svc.SettleWatermelon(user, final)
	if err != nil {
		t.Fatal(err)
	}
	if !duplicate.Idempotent || duplicate.Play.ID != res.Play.ID || duplicate.Play.Quota != 1000 || duplicate.Play.QuotaType != QuotaTypePermanent || duplicate.Grant.QuotaType != QuotaTypePermanent {
		t.Fatalf("duplicate mutated stored award: %+v", duplicate)
	}
	if atomic.LoadInt64(&mock.callCount) != 1 || countGrants(t, db, res.Play.ID) != 1 {
		t.Fatal("duplicate called external grant")
	}
	if _, err := svc.Settle(user, game2048.GameType2048, start.SessionID, 0, nil); !errors.Is(err, ErrGameSessionGone) {
		t.Fatalf("cross-game settled replay: %v", err)
	}
	other := *user
	other.ID += 100
	if _, err := svc.SettleWatermelon(&other, final); !errors.Is(err, ErrGameSessionGone) {
		t.Fatalf("cross-user settled replay: %v", err)
	}
	st, err = svc.Status(user, gamewatermelon.GameType)
	if err != nil {
		t.Fatal(err)
	}
	if st.ActiveSession != nil || st.TodayClaims != 1 || st.TodayQuota != 1000 || len(st.RecentPlays) != 1 {
		t.Fatalf("settled status: %+v", st)
	}
}

func TestWatermelonDefaultPeachTierEarnedByRealDrops(t *testing.T) {
	svc, mock, db, user := setupGameService(t)
	defer mock.Close()
	seedWatermelonConfig(t, db, DefaultWatermelonRules(), nil)
	start := startWatermelonTest(t, svc, user)
	baseTick, baseMoves := 0, 0
	for to := 600; to < 3600; to += 600 {
		from := baseTick + 1
		if baseTick == 0 {
			from = 0
		}
		cp, err := svc.CheckpointWatermelon(user, WatermelonSegment{SessionID: start.SessionID, BaseTick: baseTick, BaseMoves: baseMoves, ToTick: to, Drops: watermelonDrops(from, to)})
		if err != nil {
			t.Fatal(err)
		}
		baseTick, baseMoves = *cp.BaseTick, cp.BaseMoves
	}
	res, err := svc.SettleWatermelon(user, WatermelonSegment{SessionID: start.SessionID, BaseTick: baseTick, BaseMoves: baseMoves, ToTick: 3600, Drops: watermelonDrops(baseTick+1, 3600)})
	if err != nil {
		t.Fatal(err)
	}
	if res.Play.HighestTile != 64 || res.Play.Quota != 10000 || res.Play.QuotaType != QuotaTypePermanent || res.GrantStatus != GameGrantSuccess || atomic.LoadInt64(&mock.callCount) != 1 {
		t.Fatalf("default peach reward via real play: %+v", res.Play)
	}
}

func TestWatermelonInvalidSegmentsCannotMutateOrGrant(t *testing.T) {
	svc, mock, db, user := setupGameService(t)
	defer mock.Close()
	seedWatermelonConfig(t, db, watermelonRules(1000), nil)
	start := startWatermelonTest(t, svc, user)
	if err := db.Model(&model.GameSession{}).Where("id = ?", start.SessionID).Update("started_at", time.Now()).Error; err != nil {
		t.Fatal(err)
	}
	var before model.GameSession
	if err := db.First(&before, "id = ?", start.SessionID).Error; err != nil {
		t.Fatal(err)
	}
	cases := []struct {
		name string
		req  WatermelonSegment
		want error
	}{
		{"wrong-drop-token", WatermelonSegment{BaseMoves: 1, ToTick: 1}, ErrGameCheckpointMismatch},
		{"wrong-tick-token", WatermelonSegment{BaseTick: 1, ToTick: 2}, ErrGameCheckpointMismatch},
		{"future-clock", WatermelonSegment{ToTick: 600}, gamewatermelon.ErrInvalidInput},
		{"too-long", WatermelonSegment{ToTick: 601}, gamewatermelon.ErrInvalidInput},
		{"negative-tick", WatermelonSegment{BaseTick: -1}, gamewatermelon.ErrInvalidInput},
		{"negative-count", WatermelonSegment{BaseMoves: -1}, gamewatermelon.ErrInvalidInput},
		{"out-of-order", WatermelonSegment{ToTick: 10, Drops: []gamewatermelon.Drop{{Tick: 10, X: 180}, {Tick: 9, X: 180}}}, gamewatermelon.ErrInvalidInput},
		{"future-drop", WatermelonSegment{ToTick: 10, Drops: []gamewatermelon.Drop{{Tick: 11, X: 180}}}, gamewatermelon.ErrInvalidInput},
		{"outside-vessel", WatermelonSegment{ToTick: 10, Drops: []gamewatermelon.Drop{{Tick: 0, X: 361}}}, gamewatermelon.ErrInvalidInput},
		{"drop-cooldown", WatermelonSegment{ToTick: 2, Drops: []gamewatermelon.Drop{{Tick: 0, X: 180}, {Tick: 1, X: 180}}}, gamewatermelon.ErrInvalidInput},
		{"too-many", WatermelonSegment{ToTick: 10, Drops: make([]gamewatermelon.Drop, 33)}, gamewatermelon.ErrInvalidInput},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			tc.req.SessionID = start.SessionID
			if _, err := svc.CheckpointWatermelon(user, tc.req); !errors.Is(err, tc.want) {
				t.Fatalf("checkpoint: got %v want %v", err, tc.want)
			}
			assertNoWatermelonWrites(t, db, start.SessionID, before)
			if _, err := svc.SettleWatermelon(user, tc.req); !errors.Is(err, tc.want) {
				t.Fatalf("submit: got %v want %v", err, tc.want)
			}
			assertNoWatermelonWrites(t, db, start.SessionID, before)
		})
	}
	if atomic.LoadInt64(&mock.callCount) != 0 {
		t.Fatal("invalid inputs called grant endpoint")
	}
}

func TestWatermelonTimeOnlyAndBoundaryCheckpointTokens(t *testing.T) {
	svc, mock, db, user := setupGameService(t)
	defer mock.Close()
	seedWatermelonConfig(t, db, watermelonRules(1000), nil)
	start := startWatermelonTest(t, svc, user)
	first, err := svc.CheckpointWatermelon(user, WatermelonSegment{SessionID: start.SessionID, ToTick: 1})
	if err != nil {
		t.Fatal(err)
	}
	if first.BaseMoves != 0 || *first.BaseTick != 1 {
		t.Fatal("time-only checkpoint not versioned")
	}
	stale := WatermelonSegment{SessionID: start.SessionID, ToTick: 2}
	if _, err := svc.CheckpointWatermelon(user, stale); !errors.Is(err, ErrGameCheckpointMismatch) {
		t.Fatalf("lost response reapplication: %v", err)
	}
	if _, err := svc.SettleWatermelon(user, stale); !errors.Is(err, ErrGameCheckpointMismatch) {
		t.Fatalf("submit stale time token: %v", err)
	}
	boundary := WatermelonSegment{SessionID: start.SessionID, BaseTick: 1, ToTick: 1, Drops: []gamewatermelon.Drop{{Tick: 1, X: 180}}}
	second, err := svc.CheckpointWatermelon(user, boundary)
	if err != nil {
		t.Fatal(err)
	}
	if second.BaseMoves != 1 || *second.BaseTick != 1 {
		t.Fatal("boundary-only drop not counted")
	}
	if _, err := svc.CheckpointWatermelon(user, boundary); !errors.Is(err, ErrGameCheckpointMismatch) {
		t.Fatalf("duplicate boundary drop: %v", err)
	}
}

func TestWatermelonUserGameExpiryAndDisabledGuards(t *testing.T) {
	svc, mock, db, user := setupGameService(t)
	defer mock.Close()
	seedWatermelonConfig(t, db, watermelonRules(1000), nil)
	start := startWatermelonTest(t, svc, user)
	req := WatermelonSegment{SessionID: start.SessionID}
	for _, name := range []string{"unbound", "banned", "other-user"} {
		t.Run(name, func(t *testing.T) {
			actor := *user
			want := ErrNotBound
			switch name {
			case "unbound":
				actor.NewapiUserID = nil
			case "banned":
				actor.Status = 2
				want = ErrGameAccountBanned
			case "other-user":
				actor.ID += 100
				want = ErrGameSessionGone
			}
			if name != "other-user" {
				if _, err := svc.Start(&actor, gamewatermelon.GameType); !errors.Is(err, want) {
					t.Fatalf("start guard: %v", err)
				}
			}
			if _, err := svc.CheckpointWatermelon(&actor, req); !errors.Is(err, want) {
				t.Fatalf("checkpoint guard: %v", err)
			}
			if _, err := svc.SettleWatermelon(&actor, req); !errors.Is(err, want) {
				t.Fatalf("submit guard: %v", err)
			}
		})
	}
	other, err := svc.Start(user, game2048.GameType2048)
	if err != nil {
		t.Fatal(err)
	}
	wrong := req
	wrong.SessionID = other.SessionID
	if _, err := svc.SettleWatermelon(user, wrong); !errors.Is(err, ErrGameSessionGone) {
		t.Fatalf("active cross-game session: %v", err)
	}
	if _, err := svc.CheckpointWatermelon(user, wrong); !errors.Is(err, ErrGameSessionGone) {
		t.Fatalf("cross-game checkpoint: %v", err)
	}
	if _, err := svc.Checkpoint(user, gamewatermelon.GameType, start.SessionID, 0, nil); !errors.Is(err, ErrGameNotSupported) {
		t.Fatal("2048 decoder accepted watermelon payload")
	}
	if err := db.Model(&model.GameSession{}).Where("id = ?", start.SessionID).Update("expires_at", time.Now().Add(-time.Second)).Error; err != nil {
		t.Fatal(err)
	}
	if _, err := svc.SettleWatermelon(user, req); !errors.Is(err, ErrGameSessionExpired) {
		t.Fatalf("expired submit: %v", err)
	}
	if _, err := svc.CheckpointWatermelon(user, req); !errors.Is(err, ErrGameSessionExpired) {
		t.Fatalf("expired checkpoint: %v", err)
	}
	if err := db.Model(&model.GameSession{}).Where("id = ?", start.SessionID).Update("expires_at", time.Now().Add(time.Hour)).Error; err != nil {
		t.Fatal(err)
	}
	disabled := watermelonRules(1000)
	disabled.Enabled = false
	seedWatermelonConfig(t, db, disabled, nil)
	if _, err := svc.Start(user, gamewatermelon.GameType); !errors.Is(err, ErrGameDisabled) {
		t.Fatalf("disabled start: %v", err)
	}
	if _, err := svc.CheckpointWatermelon(user, req); !errors.Is(err, ErrGameDisabled) {
		t.Fatalf("disabled checkpoint: %v", err)
	}
	// A live round disabled by an admin can still be recorded, but earns nothing.
	res, err := svc.SettleWatermelon(user, watermelonRequest(start.SessionID))
	if err != nil {
		t.Fatal(err)
	}
	if res.Play.Reason != GameReasonDisabled || res.Play.Quota != 0 || res.Grant != nil || atomic.LoadInt64(&mock.callCount) != 0 {
		t.Fatal("disabled game granted")
	}
}

func TestWatermelonClaimLimitsCountOnlyRewardedSynthesis(t *testing.T) {
	svc, mock, db, user := setupGameService(t)
	defer mock.Close()
	rules := watermelonRules(1000)
	rules.DailyClaimLimit = 1
	seedWatermelonConfig(t, db, rules, nil)
	first := startWatermelonTest(t, svc, user)
	noMerge, err := svc.SettleWatermelon(user, WatermelonSegment{SessionID: first.SessionID, ToTick: 150, Drops: []gamewatermelon.Drop{{Tick: 0, X: 180}}})
	if err != nil {
		t.Fatal(err)
	}
	if noMerge.Play.HighestTile != 0 || noMerge.Play.Quota != 0 || noMerge.Play.Reason != GameReasonBelowTier {
		t.Fatalf("spawned fruit cannot claim: %+v", noMerge.Play)
	}
	second := startWatermelonTest(t, svc, user)
	paid, err := svc.SettleWatermelon(user, watermelonRequest(second.SessionID))
	if err != nil {
		t.Fatal(err)
	}
	if paid.Play.Reason != GameReasonOK {
		t.Fatal("no-merge game consumed claim limit")
	}
	third := startWatermelonTest(t, svc, user)
	limited, err := svc.SettleWatermelon(user, watermelonRequest(third.SessionID))
	if err != nil {
		t.Fatal(err)
	}
	if limited.Play.Reason != GameReasonOverDailyLimit || limited.Play.Quota != 0 || atomic.LoadInt64(&mock.callCount) != 1 {
		t.Fatal("daily successful-only limit failed")
	}
}

func TestWatermelonPartialCapsAndSharedBudgetLedger(t *testing.T) {
	cases := []struct {
		name                   string
		cap, game, total, want int64
		reason                 string
	}{
		{"personal-clipping", 500, 1000, 1000, 500, GameReasonOK},
		{"shared-pools-clipping", 1000, 800, 450, 450, GameReasonOK},
		{"personal-empty", 0, 1000, 1000, 0, GameReasonOverUserCap},
		{"site-empty", 1000, 0, 1000, 0, GameReasonOverSiteBudget},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			svc, mock, db, user := setupGameService(t)
			defer mock.Close()
			rules := watermelonRules(1000)
			rules.UserDailyCap = tc.cap
			seedWatermelonConfig(t, db, rules, map[string]BudgetRule{BudgetScopeGame: {Enabled: true, Daily: tc.game}, BudgetScopeTotal: {Enabled: true, Daily: tc.total}})
			start := startWatermelonTest(t, svc, user)
			res, err := svc.SettleWatermelon(user, watermelonRequest(start.SessionID))
			if err != nil {
				t.Fatal(err)
			}
			if res.Play.Reason != tc.reason || res.Play.Quota != tc.want {
				t.Fatalf("payout=%d/%s want=%d/%s", res.Play.Quota, res.Play.Reason, tc.want, tc.reason)
			}
			for _, scope := range []string{BudgetScopeGame, BudgetScopeTotal} {
				var used int64
				if err := db.Model(&model.DailyBudget{}).Where("scope = ?", scope).Select("COALESCE(SUM(used),0)").Scan(&used).Error; err != nil {
					t.Fatal(err)
				}
				if used != tc.want {
					t.Fatalf("%s consumed %d want %d", scope, used, tc.want)
				}
			}
			if tc.want > 0 {
				if res.Grant == nil || res.Grant.Quota != tc.want || atomic.LoadInt64(&mock.callCount) != 1 {
					t.Fatal("ledger differs from clipped play/budgets")
				}
			} else if res.Grant != nil || atomic.LoadInt64(&mock.callCount) != 0 {
				t.Fatal("zero award created grant")
			}
		})
	}
}

func TestWatermelonFailedDeliveryFreezesTypeAndDoesNotResend(t *testing.T) {
	svc, mock, db, user := setupGameService(t)
	defer mock.Close()
	seedWatermelonConfig(t, db, watermelonRules(1000), nil)
	atomic.StoreInt64(&mock.failNext, 1)
	start := startWatermelonTest(t, svc, user)
	req := watermelonRequest(start.SessionID)
	res, err := svc.SettleWatermelon(user, req)
	if err != nil {
		t.Fatal(err)
	}
	if res.OutErr == nil || res.GrantStatus != GameGrantFailed || res.Play.Quota != 1000 {
		t.Fatalf("failed delivery not recorded: %+v", res)
	}
	var grant model.Grant
	if err := db.First(&grant, res.Grant.ID).Error; err != nil {
		t.Fatal(err)
	}
	if grant.Status != GrantStatusFailed || grant.QuotaType != QuotaTypePermanent {
		t.Fatalf("failed grant: %+v", grant)
	}
	changed := watermelonRules(9000)
	changed.RewardType = QuotaTypeTemporary
	seedWatermelonConfig(t, db, changed, nil)
	duplicate, err := svc.SettleWatermelon(user, req)
	if err != nil {
		t.Fatal(err)
	}
	if !duplicate.Idempotent || duplicate.GrantStatus != GameGrantFailed || duplicate.Grant.QuotaType != QuotaTypePermanent || duplicate.Play.Quota != 1000 || atomic.LoadInt64(&mock.callCount) != 1 {
		t.Fatal("repeated failure resent or recomputed award")
	}
}

func TestWatermelonConcurrentStartAndDefaultCooldown(t *testing.T) {
	svc, mock, db, user := setupGameService(t)
	defer mock.Close()
	rules := watermelonRules(1000)
	rules.CooldownSeconds = 60
	seedWatermelonConfig(t, db, rules, nil)
	var wg sync.WaitGroup
	var wins atomic.Int32
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, err := svc.Start(user, gamewatermelon.GameType)
			if err == nil {
				wins.Add(1)
			} else if !errors.Is(err, ErrGameSessionExists) {
				t.Errorf("start: %v", err)
			}
		}()
	}
	wg.Wait()
	if wins.Load() != 1 {
		t.Fatalf("concurrent starts won %d times", wins.Load())
	}
	if err := svc.Cancel(user, gamewatermelon.GameType); err != nil {
		t.Fatal(err)
	}
	start := startWatermelonTest(t, svc, user)
	if _, err := svc.SettleWatermelon(user, watermelonRequest(start.SessionID)); err != nil {
		t.Fatal(err)
	}
	var cooldown *GameCooldownError
	if _, err := svc.Start(user, gamewatermelon.GameType); !errors.As(err, &cooldown) || cooldown.Remaining < 59 {
		t.Fatalf("cooldown missing: %v", err)
	}
}

func TestWatermelonCancelIsScopedAndCanDiscardCorruptExpiredSaves(t *testing.T) {
	svc, mock, db, user := setupGameService(t)
	defer mock.Close()
	seedWatermelonConfig(t, db, watermelonRules(1000), nil)
	old := startWatermelonTest(t, svc, user)
	if err := svc.CancelWatermelon(user, old.SessionID); err != nil {
		t.Fatal(err)
	}
	current := startWatermelonTest(t, svc, user)
	legacy, err := svc.Start(user, game2048.GameType2048)
	if err != nil {
		t.Fatal(err)
	}
	var before model.GameSession
	if err := db.First(&before, "id = ?", current.SessionID).Error; err != nil {
		t.Fatal(err)
	}
	for _, invalid := range []string{"", "short", strings.Repeat("z", 32), strings.Repeat("a", 64)} {
		if err := svc.CancelWatermelon(user, invalid); !errors.Is(err, gamewatermelon.ErrInvalidInput) {
			t.Fatalf("invalid cancel: %v", err)
		}
		assertNoWatermelonWrites(t, db, current.SessionID, before)
	}
	for _, id := range []string{old.SessionID, legacy.SessionID, strings.Repeat("a", 32)} {
		if err := svc.CancelWatermelon(user, id); err != nil {
			t.Fatal(err)
		}
		assertNoWatermelonWrites(t, db, current.SessionID, before)
	}
	other := *user
	other.ID += 100
	if err := svc.CancelWatermelon(&other, current.SessionID); err != nil {
		t.Fatal(err)
	}
	assertNoWatermelonWrites(t, db, current.SessionID, before)
	var legacyCount int64
	if err := db.Model(&model.GameSession{}).Where("id = ?", legacy.SessionID).Count(&legacyCount).Error; err != nil || legacyCount != 1 {
		t.Fatalf("cross-game cancel changed 2048 session: count=%d err=%v", legacyCount, err)
	}
	// Cleanup must still work when the save cannot be decoded or the account has
	// since been unbound; cancellation neither replays nor awards anything.
	if err := db.Model(&model.GameSession{}).Where("id = ?", current.SessionID).
		Updates(map[string]any{"payload": "corrupt", "expires_at": time.Now().Add(-time.Second)}).Error; err != nil {
		t.Fatal(err)
	}
	user.NewapiUserID = nil
	for attempt := 0; attempt < 2; attempt++ {
		if err := svc.CancelWatermelon(user, current.SessionID); err != nil {
			t.Fatal(err)
		}
	}
	var remaining int64
	if err := db.Model(&model.GameSession{}).Where("id = ?", current.SessionID).Count(&remaining).Error; err != nil || remaining != 0 {
		t.Fatalf("unrecoverable session not canceled: count=%d err=%v", remaining, err)
	}
	if atomic.LoadInt64(&mock.callCount) != 0 {
		t.Fatal("cancellation made a grant request")
	}
}

func TestGameStatusReportsZeroBudgetBeforeAnyUsage(t *testing.T) {
	for _, tc := range []struct {
		name      string
		scope     string
		rule      BudgetRule
		exhausted bool
	}{
		{"zero-game", BudgetScopeGame, BudgetRule{Enabled: true, Daily: 0}, true},
		{"zero-total", BudgetScopeTotal, BudgetRule{Enabled: true, Daily: 0}, true},
		{"disabled", BudgetScopeGame, BudgetRule{Enabled: false, Daily: 0}, false},
		{"positive", BudgetScopeGame, BudgetRule{Enabled: true, Daily: 1}, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			svc, mock, db, user := setupGameService(t)
			defer mock.Close()
			seedWatermelonConfig(t, db, watermelonRules(1000), map[string]BudgetRule{tc.scope: tc.rule})
			for _, gameType := range SupportedGames() {
				status, err := svc.Status(user, gameType)
				if err != nil {
					t.Fatal(err)
				}
				if status.BudgetExhausted != tc.exhausted {
					t.Fatalf("%s budget exhausted=%v want=%v", gameType, status.BudgetExhausted, tc.exhausted)
				}
			}
			var count int64
			if err := db.Model(&model.DailyBudget{}).Count(&count).Error; err != nil || count != 0 {
				t.Fatalf("status created budget usage: count=%d err=%v", count, err)
			}
		})
	}
}
