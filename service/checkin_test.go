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

// TestCheckinBlockedByNewAPICheckin 验证跨系统防重签:new-api 说当日已签 → 福利站拒绝,
// 且不产生 w_checkins 与流水;未签 → 正常放行;旧版 new-api 不返回新字段 → 视为未签。
func TestCheckinBlockedByNewAPICheckin(t *testing.T) {
	cases := []struct {
		name       string
		checkedIn  bool
		omitFields bool
		wantErr    error
	}{
		{"new-api 已签到则拒绝", true, false, ErrCheckedInOnNewAPI},
		{"new-api 未签到则放行", false, false, nil},
		{"旧版 new-api 无新字段视为未签到", true, true, nil},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			svc, mock, db := setupGrantService(t)
			defer mock.Close()
			if tc.checkedIn {
				atomic.StoreInt64(&mock.checkedInToday, 1)
			}
			if tc.omitFields {
				atomic.StoreInt64(&mock.omitCheckinFields, 1)
			}
			user := model.User{LinuxDOID: "u", LinuxDOName: "u", TrustLevel: 2, Status: 1, NewapiUserID: int64Ptr(42)}
			db.Create(&user)

			_, err := DoCheckin(db, svc, fixedConfig(true, 1000), &user)
			if !errors.Is(err, tc.wantErr) {
				t.Fatalf("err = %v, want %v", err, tc.wantErr)
			}

			var checkins, grants int64
			db.Model(&model.Checkin{}).Where("user_id = ?", user.ID).Count(&checkins)
			db.Model(&model.Grant{}).Where("user_id = ?", user.ID).Count(&grants)
			wantRows := int64(1)
			if tc.wantErr != nil {
				wantRows = 0
			}
			if checkins != wantRows || grants != wantRows {
				t.Fatalf("签到记录=%d 流水=%d, want %d/%d", checkins, grants, wantRows, wantRows)
			}
		})
	}
}

// TestCheckinStillBlocksWhenLocalTemporaryDrawExists 验证即使福利站存在当日
// 限时抽奖记录,也不能据此推断 new-api 的 checked_in_today 来源并放行签到。
// 这条回归防止未来再次引入不可靠的“存量兼容”双发漏洞。
func TestCheckinStillBlocksWhenLocalTemporaryDrawExists(t *testing.T) {
	svc, mock, db := setupGrantService(t)
	defer mock.Close()
	atomic.StoreInt64(&mock.checkedInToday, 1)

	user := model.User{
		LinuxDOID: "local-draw-before-checkin", LinuxDOName: "u", TrustLevel: 2,
		Status: 1, NewapiUserID: int64Ptr(42),
	}
	if err := db.Create(&user).Error; err != nil {
		t.Fatalf("create user: %v", err)
	}
	today := TodayStr(DefaultCheckinConfig().Timezone, time.Now())
	draw := model.Draw{
		UserID: user.ID, DrawDate: today, Roll: 95, TierLabel: "小欧一把",
		Quota: 500, QuotaType: QuotaTypeTemporary, Reason: DrawReasonOK,
	}
	if err := db.Create(&draw).Error; err != nil {
		t.Fatalf("create draw: %v", err)
	}
	grant := model.Grant{
		UserID: user.ID, NewapiUserID: 42, Type: GrantTypeDraw, RefID: draw.ID,
		Quota: 500, QuotaType: QuotaTypeTemporary, Status: GrantStatusSuccess,
	}
	if err := db.Create(&grant).Error; err != nil {
		t.Fatalf("create draw grant: %v", err)
	}

	_, err := DoCheckin(db, svc, fixedConfig(true, 1000), &user)
	if !errors.Is(err, ErrCheckedInOnNewAPI) {
		t.Fatalf("new-api 已签到时仍应拦截,实际 %v", err)
	}
	var checkins, checkinGrants int64
	db.Model(&model.Checkin{}).Where("user_id = ?", user.ID).Count(&checkins)
	db.Model(&model.Grant{}).
		Where("user_id = ? AND type = ?", user.ID, "checkin").
		Count(&checkinGrants)
	if checkins != 0 || checkinGrants != 0 {
		t.Fatalf("被拦截时不应新增签到记录/流水: %d/%d", checkins, checkinGrants)
	}
}

// TestCheckinOpenTimeBoundary 验证开放时间边界判定与默认不限制。
func TestCheckinOpenTimeBoundary(t *testing.T) {
	cfg := fixedConfig(true, 1000)
	cfg.Timezone = "Asia/Shanghai"
	cfg.AvailableFromMinutes = 480 // 08:00

	// 以下时刻均为 UTC,对应北京时间 07:59 / 08:00 / 08:01。
	cases := []struct {
		utc  time.Time
		want bool
		desc string
	}{
		{time.Date(2026, 8, 18, 23, 59, 0, 0, time.UTC), false, "开放前一分钟"},
		{time.Date(2026, 8, 19, 0, 0, 0, 0, time.UTC), true, "正好开放"},
		{time.Date(2026, 8, 19, 0, 1, 0, 0, time.UTC), true, "开放后"},
	}
	for _, tc := range cases {
		if got := CheckinOpened(cfg, tc.utc); got != tc.want {
			t.Errorf("%s: CheckinOpened = %v, want %v", tc.desc, got, tc.want)
		}
	}

	// 默认 0 不限制,哪怕是凌晨。
	cfg.AvailableFromMinutes = 0
	if !CheckinOpened(cfg, time.Date(2026, 8, 18, 16, 0, 0, 0, time.UTC)) {
		t.Error("默认 0 应不限制")
	}

	// 同一时刻换时区结论不同:UTC 下才 00:00,未到 08:00。
	cfg.AvailableFromMinutes = 480
	cfg.Timezone = "UTC"
	if CheckinOpened(cfg, time.Date(2026, 8, 19, 0, 0, 0, 0, time.UTC)) {
		t.Error("UTC 时区下 00:00 不应视为已开放")
	}

	if got := FormatOpenTime(480); got != "08:00" {
		t.Errorf("FormatOpenTime(480) = %q", got)
	}
}

// TestDoCheckinBeforeOpenTime 验证未到开放时间时签到被拒且无副作用。
func TestDoCheckinBeforeOpenTime(t *testing.T) {
	svc, mock, db := setupGrantService(t)
	defer mock.Close()
	user := model.User{LinuxDOID: "u", LinuxDOName: "u", TrustLevel: 2, Status: 1, NewapiUserID: int64Ptr(42)}
	db.Create(&user)

	cfg := fixedConfig(true, 1000)
	cfg.Timezone = "Asia/Shanghai"
	// 把开放时间设为当前之后一分钟,保证"未到点"。
	local := time.Now().In(mustLoad(t, cfg.Timezone))
	minutes := local.Hour()*60 + local.Minute() + 1
	if minutes > 1439 {
		t.Skip("跨日边界,跳过")
	}
	cfg.AvailableFromMinutes = minutes

	if _, err := DoCheckin(db, svc, cfg, &user); !errors.Is(err, ErrCheckinNotOpen) {
		t.Fatalf("err = %v, want ErrCheckinNotOpen", err)
	}
	var count int64
	db.Model(&model.Checkin{}).Count(&count)
	if count != 0 {
		t.Fatalf("不应产生签到记录,got %d", count)
	}
}

func mustLoad(t *testing.T, tz string) *time.Location {
	t.Helper()
	loc, err := time.LoadLocation(tz)
	if err != nil {
		t.Fatalf("load %s: %v", tz, err)
	}
	return loc
}
