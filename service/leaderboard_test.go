package service

import (
	"fmt"
	"testing"
	"time"

	"welfare/model"

	"gorm.io/gorm"
)

const lbTZ = "Asia/Shanghai"

// lbNow = 2026-08-19(周三)北京时间 09:00;本周一为 08-17。
var lbNow = time.Date(2026, 8, 19, 1, 0, 0, 0, time.UTC)

func lbUser(t *testing.T, db *gorm.DB, i int, status int) model.User {
	t.Helper()
	u := model.User{LinuxDOID: fmt.Sprintf("lb%03d", i), LinuxDOName: fmt.Sprintf("user%03d", i), DisplayName: "", AvatarURL: fmt.Sprintf("https://cdn.example/%d.png", i), Status: status}
	if i%2 == 0 {
		u.DisplayName = fmt.Sprintf("昵称 %d", i)
	}
	if err := db.Create(&u).Error; err != nil {
		t.Fatalf("create user %d: %v", i, err)
	}
	return u
}

// TestStreakLeaderboard 用 100 个用户验证连签榜:按 streak 倒序取前 20,断签与封禁的
// 不计入,「我的名次」= 比我高的人数 + 1;昨天签到今天未签的仍在榜。
func TestStreakLeaderboard(t *testing.T) {
	ResetLeaderboardCache()
	db := grantDB(t)
	today := TodayStr(lbTZ, lbNow)
	yesterday := TodayStr(lbTZ, lbNow.AddDate(0, 0, -1))
	stale := TodayStr(lbTZ, lbNow.AddDate(0, 0, -3))

	users := make([]model.User, 0, 101)
	for i := 1; i <= 100; i++ {
		u := lbUser(t, db, i, 1)
		users = append(users, u)
		date := today
		switch i {
		case 50:
			date = stale // 三天前签的,连签已断
		case 51:
			date = yesterday // 昨天签到今天未签,仍算连着
		}
		// 每人再补一条更早的记录,确保「取最近一条」逻辑真的在起作用。
		for _, c := range []model.Checkin{
			{UserID: u.ID, CheckinDate: "2026-01-01", Quota: 1, Streak: 999},
			{UserID: u.ID, CheckinDate: date, Quota: 1, Streak: i},
		} {
			if err := db.Create(&c).Error; err != nil {
				t.Fatalf("create checkin: %v", err)
			}
		}
	}
	banned := lbUser(t, db, 101, 2)
	if err := db.Create(&model.Checkin{UserID: banned.ID, CheckinDate: today, Quota: 1, Streak: 500}).Error; err != nil {
		t.Fatalf("create banned checkin: %v", err)
	}

	view, err := Leaderboard(db, LeaderboardKindStreak, lbTZ, lbNow, nil)
	if err != nil {
		t.Fatalf("leaderboard: %v", err)
	}
	if view.Kind != LeaderboardKindStreak || view.Since != today || view.Me != nil {
		t.Fatalf("view meta = %+v", view)
	}
	if len(view.Items) != 20 {
		t.Fatalf("items = %d, want 20", len(view.Items))
	}
	for i, item := range view.Items {
		want := int64(100 - i)
		if item.Value != want {
			t.Fatalf("第 %d 名 streak = %d, want %d", i+1, item.Value, want)
		}
		if item.UserID == banned.ID || item.Value == 500 || item.Value == 999 {
			t.Fatalf("封禁用户或过期记录混入榜单: %+v", item)
		}
	}
	if first := view.Items[0]; first.Name != "昵称 100" || first.AvatarURL != "https://cdn.example/100.png" {
		t.Fatalf("首位展示名/头像不对: %+v", first)
	}
	if view.Items[1].Name != "user099" {
		t.Fatalf("没有显示名时应回退 LinuxDO 用户名: %+v", view.Items[1])
	}

	// 昨天签到的 51:比他高的是 52..100 共 49 人 → 第 50 名。
	mine, err := Leaderboard(db, LeaderboardKindStreak, lbTZ, lbNow, &users[50])
	if err != nil || mine.Me == nil || mine.Me.Rank != 50 || mine.Me.Value != 51 {
		t.Fatalf("user51 rank = %+v err=%v, want rank 50 value 51", mine.Me, err)
	}
	// 断签的 50 不在榜上。
	broken, err := Leaderboard(db, LeaderboardKindStreak, lbTZ, lbNow, &users[49])
	if err != nil || broken.Me != nil {
		t.Fatalf("断签用户不应有名次: %+v err=%v", broken.Me, err)
	}
	// 连签 1 天的 user1:活跃用户 99 人(去掉 50),比他高 98 人 → 第 99 名。
	last, err := Leaderboard(db, LeaderboardKindStreak, lbTZ, lbNow, &users[0])
	if err != nil || last.Me == nil || last.Me.Rank != 99 {
		t.Fatalf("user1 rank = %+v err=%v, want 99", last.Me, err)
	}
}

// TestGameLeaderboard 验证本周高分榜:每人取本周最高分、跨游戏比较并标注来源,
// 上周成绩与封禁用户不计入,「我的名次」正确,本周没玩的没有名次。
func TestGameLeaderboard(t *testing.T) {
	ResetLeaderboardCache()
	db := grantDB(t)
	weekStart := WeekStart(lbTZ, lbNow)
	if weekStart != "2026-08-17" {
		t.Fatalf("weekStart = %s, want 2026-08-17(周一)", weekStart)
	}
	play := func(userID int64, game string, date string, score int64) {
		t.Helper()
		p := model.GamePlay{UserID: userID, GameType: game, SessionID: fmt.Sprintf("%d-%s-%s-%d", userID, game, date, score), PlayDate: date, Score: score, Reason: "ok"}
		if err := db.Create(&p).Error; err != nil {
			t.Fatalf("create play: %v", err)
		}
	}
	users := make([]model.User, 0, 31)
	for i := 1; i <= 30; i++ {
		u := lbUser(t, db, i, 1)
		users = append(users, u)
		play(u.ID, "2048", "2026-08-18", int64(i*10)) // 本周最高分
		play(u.ID, "2048", "2026-08-17", int64(i*3))
		play(u.ID, "watermelon", "2026-08-19", int64(i*5))
	}
	// user7 上周有个天文数字,不算;banned 本周 5000 分,不算。
	play(users[6].ID, "2048", "2026-08-16", 99999)
	banned := lbUser(t, db, 31, 2)
	play(banned.ID, "watermelon", "2026-08-18", 5000)
	// user30 的西瓜分与 2048 并列最高:并列按游戏名排序,2048 在前。
	play(users[29].ID, "watermelon", "2026-08-18", 300)
	idle := lbUser(t, db, 32, 1)

	view, err := Leaderboard(db, LeaderboardKindGame, lbTZ, lbNow, nil)
	if err != nil {
		t.Fatalf("leaderboard: %v", err)
	}
	if view.Since != weekStart || len(view.Items) != 20 {
		t.Fatalf("since=%s items=%d", view.Since, len(view.Items))
	}
	for i, item := range view.Items {
		want := int64((30 - i) * 10)
		if item.Value != want || item.GameType != "2048" {
			t.Fatalf("第 %d 名 = %+v, want value %d game 2048", i+1, item, want)
		}
	}

	me, err := Leaderboard(db, LeaderboardKindGame, lbTZ, lbNow, &users[6])
	if err != nil || me.Me == nil || me.Me.Rank != 24 || me.Me.Value != 70 {
		t.Fatalf("user7 rank = %+v err=%v, want rank 24 value 70", me.Me, err)
	}
	none, err := Leaderboard(db, LeaderboardKindGame, lbTZ, lbNow, &idle)
	if err != nil || none.Me != nil {
		t.Fatalf("本周没玩的不应有名次: %+v err=%v", none.Me, err)
	}
}

// TestLeaderboardCache 验证榜单本体缓存 60 秒:期间新数据不可见,过期后刷新;
// 「我的名次」不走缓存,随时反映最新数据。
func TestLeaderboardCache(t *testing.T) {
	ResetLeaderboardCache()
	db := grantDB(t)
	today := TodayStr(lbTZ, lbNow)
	a := lbUser(t, db, 1, 1)
	db.Create(&model.Checkin{UserID: a.ID, CheckinDate: today, Quota: 1, Streak: 5})

	first, err := Leaderboard(db, LeaderboardKindStreak, lbTZ, lbNow, nil)
	if err != nil || len(first.Items) != 1 || first.Items[0].Value != 5 {
		t.Fatalf("first = %+v err=%v", first, err)
	}
	b := lbUser(t, db, 2, 1)
	db.Create(&model.Checkin{UserID: b.ID, CheckinDate: today, Quota: 1, Streak: 9})

	cached, err := Leaderboard(db, LeaderboardKindStreak, lbTZ, lbNow.Add(30*time.Second), &b)
	if err != nil || len(cached.Items) != 1 || cached.Items[0].Value != 5 {
		t.Fatalf("30 秒内应命中缓存: %+v err=%v", cached.Items, err)
	}
	if cached.Me == nil || cached.Me.Rank != 1 || cached.Me.Value != 9 {
		t.Fatalf("我的名次不应被缓存: %+v", cached.Me)
	}
	fresh, err := Leaderboard(db, LeaderboardKindStreak, lbTZ, lbNow.Add(61*time.Second), nil)
	if err != nil || len(fresh.Items) != 2 || fresh.Items[0].Value != 9 {
		t.Fatalf("过期后应刷新: %+v err=%v", fresh.Items, err)
	}
	// 返回的切片是副本,调用方改动不会污染缓存。
	fresh.Items[0].Name = "篡改"
	again, _ := Leaderboard(db, LeaderboardKindStreak, lbTZ, lbNow.Add(62*time.Second), nil)
	if again.Items[0].Name == "篡改" {
		t.Fatal("缓存不应被调用方修改")
	}
}
