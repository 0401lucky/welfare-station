package service

import (
	"testing"
	"time"

	"welfare/model"

	"gorm.io/gorm"
)

func seedSuccessGrant(t *testing.T, db *gorm.DB, userID, quota int64, status string, createdAt time.Time) {
	t.Helper()
	g := model.Grant{UserID: userID, NewapiUserID: 42, Type: "manual", RefID: NewManualRefID(), Quota: quota, QuotaType: QuotaTypePermanent, Status: status}
	if err := db.Create(&g).Error; err != nil {
		t.Fatalf("create grant: %v", err)
	}
	if err := db.Model(&g).UpdateColumn("created_at", createdAt).Error; err != nil {
		t.Fatalf("set created_at: %v", err)
	}
}

// TestDashboardTrendSevenDays 用固定数据验证 7 天四条序列:日界按配置时区,
// 窗口外与失败流水不计入,没有记录的日期补 0。
func TestDashboardTrendSevenDays(t *testing.T) {
	db := grantDB(t)
	const tz = "Asia/Shanghai"
	// now = 2026-08-19 09:00 北京时间;窗口 08-13 ~ 08-19。
	now := time.Date(2026, 8, 19, 1, 0, 0, 0, time.UTC)

	for _, c := range []model.Checkin{
		{UserID: 1, CheckinDate: "2026-08-19", Quota: 1, Streak: 1},
		{UserID: 2, CheckinDate: "2026-08-19", Quota: 1, Streak: 1},
		{UserID: 1, CheckinDate: "2026-08-15", Quota: 1, Streak: 1},
		{UserID: 1, CheckinDate: "2026-08-12", Quota: 1, Streak: 1}, // 窗口外
	} {
		if err := db.Create(&c).Error; err != nil {
			t.Fatalf("create checkin: %v", err)
		}
	}
	for _, d := range []model.Draw{
		{UserID: 1, DrawDate: "2026-08-19", Roll: 5, TierLabel: "x", Reason: DrawReasonOK},
		{UserID: 1, DrawDate: "2026-08-13", Roll: 5, TierLabel: "x", Reason: DrawReasonOK},
	} {
		if err := db.Create(&d).Error; err != nil {
			t.Fatalf("create draw: %v", err)
		}
	}
	for i, p := range []model.GamePlay{
		{UserID: 1, GameType: "2048", SessionID: "s1", PlayDate: "2026-08-18", Reason: "ok"},
		{UserID: 1, GameType: "2048", SessionID: "s2", PlayDate: "2026-08-18", Reason: "ok"},
		{UserID: 2, GameType: "2048", SessionID: "s3", PlayDate: "2026-08-18", Reason: "below_tier"},
	} {
		if err := db.Create(&p).Error; err != nil {
			t.Fatalf("create play %d: %v", i, err)
		}
	}
	// 北京时间 08-19 00:30 → 08-19;08-18 23:30 → 08-18;08-12 → 窗口外;失败流水不计。
	seedSuccessGrant(t, db, 1, 100, GrantStatusSuccess, time.Date(2026, 8, 18, 16, 30, 0, 0, time.UTC))
	seedSuccessGrant(t, db, 1, 20, GrantStatusSuccess, time.Date(2026, 8, 18, 15, 30, 0, 0, time.UTC))
	seedSuccessGrant(t, db, 1, 7, GrantStatusSuccess, time.Date(2026, 8, 18, 15, 0, 0, 0, time.UTC))
	seedSuccessGrant(t, db, 1, 999, GrantStatusFailed, time.Date(2026, 8, 18, 16, 30, 0, 0, time.UTC))
	seedSuccessGrant(t, db, 1, 555, GrantStatusSuccess, time.Date(2026, 8, 12, 10, 0, 0, 0, time.UTC))

	got, err := DashboardTrend(db, tz, 7, now)
	if err != nil {
		t.Fatalf("trend: %v", err)
	}
	want := []TrendDay{
		{Date: "2026-08-13", Draws: 1},
		{Date: "2026-08-14"},
		{Date: "2026-08-15", Checkins: 1},
		{Date: "2026-08-16"},
		{Date: "2026-08-17"},
		{Date: "2026-08-18", Plays: 3, Quota: 27},
		{Date: "2026-08-19", Checkins: 2, Draws: 1, Quota: 100},
	}
	if len(got) != len(want) {
		t.Fatalf("len = %d, want %d: %+v", len(got), len(want), got)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("day %d = %+v, want %+v", i, got[i], want[i])
		}
	}

	// days 夹到 1..30。
	if one, err := DashboardTrend(db, tz, 0, now); err != nil || len(one) != 1 || one[0].Date != "2026-08-19" {
		t.Fatalf("days=0 应回落 1 天: %+v err=%v", one, err)
	}
	if many, err := DashboardTrend(db, tz, 90, now); err != nil || len(many) != maxTrendDays {
		t.Fatalf("days=90 应夹到 %d 天: len=%d err=%v", maxTrendDays, len(many), err)
	}
}

// TestCurrentStreak 验证连签口径:最近一次在今天或昨天取其 streak,更早则为 0,无记录为 0。
func TestCurrentStreak(t *testing.T) {
	db := grantDB(t)
	const tz = "Asia/Shanghai"
	now := time.Date(2026, 8, 19, 1, 0, 0, 0, time.UTC) // 北京 08-19

	if s, err := CurrentStreak(db, 1, tz, now); err != nil || s != 0 {
		t.Fatalf("无记录应为 0: %d %v", s, err)
	}
	for _, c := range []model.Checkin{
		{UserID: 1, CheckinDate: "2026-08-17", Quota: 1, Streak: 1},
		{UserID: 1, CheckinDate: "2026-08-18", Quota: 1, Streak: 2},
		{UserID: 2, CheckinDate: "2026-08-15", Quota: 1, Streak: 9},
	} {
		if err := db.Create(&c).Error; err != nil {
			t.Fatalf("create: %v", err)
		}
	}
	if s, err := CurrentStreak(db, 1, tz, now); err != nil || s != 2 {
		t.Fatalf("昨天签过应沿用 streak=2: %d %v", s, err)
	}
	if s, err := CurrentStreak(db, 2, tz, now); err != nil || s != 0 {
		t.Fatalf("四天前的连签已断: %d %v", s, err)
	}
	if err := db.Create(&model.Checkin{UserID: 1, CheckinDate: "2026-08-19", Quota: 1, Streak: 3}).Error; err != nil {
		t.Fatalf("create today: %v", err)
	}
	if s, err := CurrentStreak(db, 1, tz, now); err != nil || s != 3 {
		t.Fatalf("今天签过应为 3: %d %v", s, err)
	}
}
