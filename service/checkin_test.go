package service

import (
	"errors"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"welfare/model"
)

func fixedConfig(enabled bool, fixed int64) *CheckinConfig {
	c := DefaultCheckinConfig()
	c.Enabled = enabled
	c.Mode = "fixed"
	c.FixedQuota = fixed
	return c
}

// TestTodayStrTimezoneBoundary verifies the day boundary follows the
// configured timezone, not UTC (R2.1).
func TestTodayStrTimezoneBoundary(t *testing.T) {
	instant := time.Date(2026, 8, 18, 23, 30, 0, 0, time.UTC)
	if got := TodayStr("Asia/Shanghai", instant); got != "2026-08-19" {
		t.Fatalf("Asia/Shanghai should be 2026-08-19, got %s", got)
	}
	if got := TodayStr("UTC", instant); got != "2026-08-18" {
		t.Fatalf("UTC should be 2026-08-18, got %s", got)
	}
	if got := TodayStr("America/Los_Angeles", instant); got != "2026-08-18" {
		t.Fatalf("America/Los_Angeles should be 2026-08-18, got %s", got)
	}
}

// TestComputeRewardStreakTiers verifies streak 1/3/7/30 reward math.
func TestComputeRewardStreakTiers(t *testing.T) {
	cfg := fixedConfig(true, 100000)
	cfg.StreakBonuses = []StreakBonus{
		{Days: 3, Bonus: 0.10},
		{Days: 7, Bonus: 0.25},
		{Days: 30, Bonus: 0.50},
	}

	cases := []struct {
		streak    int
		wantBase  int64
		wantBonus float64
		wantTotal int64
	}{
		{1, 100000, 0.00, 100000},
		{3, 100000, 0.10, 110000},
		{7, 100000, 0.25, 125000},
		{30, 100000, 0.50, 150000},
		{31, 100000, 0.50, 150000}, // beyond highest tier still capped
	}
	for _, tc := range cases {
		base, bonus, total, err := ComputeReward(cfg, tc.streak)
		if err != nil {
			t.Fatalf("streak %d: %v", tc.streak, err)
		}
		if base != tc.wantBase || bonus != tc.wantBonus || total != tc.wantTotal {
			t.Errorf("streak %d: got base=%d bonus=%.2f total=%d, want %d/%.2f/%d",
				tc.streak, base, bonus, total, tc.wantBase, tc.wantBonus, tc.wantTotal)
		}
	}
}

// TestCalcStreak verifies yesterday+1 and reset-to-1 logic.
func TestCalcStreak(t *testing.T) {
	db := grantDB(t)
	_ = model.Migrate(db)
	now := time.Date(2026, 8, 18, 12, 0, 0, 0, time.UTC)
	db.Create(&model.Checkin{UserID: 1, CheckinDate: "2026-08-16", Quota: 10, Streak: 1})
	db.Create(&model.Checkin{UserID: 1, CheckinDate: "2026-08-17", Quota: 10, Streak: 2})

	streak, err := CalcStreak(db, 1, now, "UTC")
	if err != nil {
		t.Fatalf("calc: %v", err)
	}
	if streak != 3 {
		t.Fatalf("expected streak 3 (yesterday was streak 2), got %d", streak)
	}

	// A user who skipped yesterday resets to 1.
	db.Create(&model.Checkin{UserID: 2, CheckinDate: "2026-08-15", Quota: 10, Streak: 5})
	streak2, err := CalcStreak(db, 2, now, "UTC")
	if err != nil {
		t.Fatalf("calc: %v", err)
	}
	if streak2 != 1 {
		t.Fatalf("expected reset to 1 after a gap, got %d", streak2)
	}
}

// TestSameDayConcurrentCheckin verifies the uk_user_date unique constraint
// allows exactly one check-in per user per day under concurrency (R2.4).
func TestSameDayConcurrentCheckin(t *testing.T) {
	svc, mock, db := setupGrantService(t)
	defer mock.Close()

	user := model.User{LinuxDOID: "10001", LinuxDOName: "alice", TrustLevel: 2, Status: 1, NewapiUserID: int64Ptr(42)}
	if err := db.Create(&user).Error; err != nil {
		t.Fatalf("create user: %v", err)
	}

	cfg := fixedConfig(true, 1000)
	var wg sync.WaitGroup
	results := make([]*CheckinResult, 8)
	errs := make([]error, 8)
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			res, err := DoCheckin(db, svc, cfg, &user)
			results[i] = res
			errs[i] = err
		}(i)
	}
	wg.Wait()

	ok := 0
	for i := 0; i < 8; i++ {
		if errs[i] == nil {
			ok++
		} else if !errors.Is(errs[i], ErrAlreadyCheckedIn) {
			t.Fatalf("unexpected error: %v", errs[i])
		}
	}
	if ok != 1 {
		t.Fatalf("expected exactly 1 successful check-in, got %d", ok)
	}

	var count int64
	db.Model(&model.Checkin{}).Where("user_id = ? AND checkin_date = ?", user.ID, TodayStr(cfg.Timezone, time.Now())).Count(&count)
	if count != 1 {
		t.Fatalf("expected 1 checkin row, got %d", count)
	}
	if atomic.LoadInt64(&mock.successCalls) != 1 {
		t.Fatalf("expected exactly 1 outbound payout, got %d", mock.successCalls)
	}

	// The successful result must carry the correct streak & quota.
	for i := 0; i < 8; i++ {
		if errs[i] == nil && results[i] != nil {
			if results[i].Checkin.Quota != 1000 || results[i].Checkin.Streak != 1 {
				t.Fatalf("bad successful result: %+v", results[i])
			}
		}
	}
}

// TestDoCheckinDisabled verifies the enabled=false gate.
func TestDoCheckinDisabled(t *testing.T) {
	svc, mock, db := setupGrantService(t)
	defer mock.Close()
	user := model.User{LinuxDOID: "u", LinuxDOName: "u", TrustLevel: 2, Status: 1, NewapiUserID: int64Ptr(1)}
	db.Create(&user)
	_, err := DoCheckin(db, svc, fixedConfig(false, 1000), &user)
	if !errors.Is(err, ErrCheckinDisabled) {
		t.Fatalf("expected ErrCheckinDisabled, got %v", err)
	}
}

// TestCheckinRewardTypeTemporary 验证限时额度模式的签到打到 temporary_quota 接口,
// 且流水持久化了该类型;permanent 模式(含存量空值)仍走永久额度接口。
func TestCheckinRewardTypeTemporary(t *testing.T) {
	cases := []struct {
		name       string
		rewardType string
		wantTemp   int64
		wantPerm   int64
		wantStored string
	}{
		{"限时额度", QuotaTypeTemporary, 1, 0, QuotaTypeTemporary},
		{"永久额度", QuotaTypePermanent, 0, 1, QuotaTypePermanent},
		{"存量配置空值按永久", "", 0, 1, QuotaTypePermanent},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			svc, mock, db := setupGrantService(t)
			defer mock.Close()
			user := model.User{LinuxDOID: "u", LinuxDOName: "u", TrustLevel: 2, Status: 1, NewapiUserID: int64Ptr(7)}
			db.Create(&user)

			cfg := fixedConfig(true, 1000)
			cfg.RewardType = tc.rewardType
			res, err := DoCheckin(db, svc, cfg, &user)
			if err != nil {
				t.Fatalf("checkin: %v", err)
			}
			if res.OutErr != nil {
				t.Fatalf("外呼不应失败: %v", res.OutErr)
			}
			if got := atomic.LoadInt64(&mock.tempCalls); got != tc.wantTemp {
				t.Fatalf("temporary_quota 调用次数 = %d, want %d", got, tc.wantTemp)
			}
			if got := atomic.LoadInt64(&mock.permCalls); got != tc.wantPerm {
				t.Fatalf("manage 调用次数 = %d, want %d", got, tc.wantPerm)
			}
			var g model.Grant
			db.First(&g, res.Grant.ID)
			if g.QuotaType != tc.wantStored {
				t.Fatalf("流水记录的额度类型 = %q, want %q", g.QuotaType, tc.wantStored)
			}
		})
	}
}
