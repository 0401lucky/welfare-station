package model

import (
	"strings"
	"testing"
	"time"
)

// TestGameTablesMigrated 验证三张新表随 AutoMigrate 生成。
func TestGameTablesMigrated(t *testing.T) {
	db := testDB(t)
	if err := Migrate(db); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	for _, table := range []string{"w_game_sessions", "w_game_plays", "w_daily_budgets"} {
		if !db.Migrator().HasTable(table) {
			t.Errorf("expected table %s to exist", table)
		}
	}
}

// TestGameUniqueIndexes 验证 uk_user_game / uk_session / idx_user_date 实际生成。
func TestGameUniqueIndexes(t *testing.T) {
	db := testDB(t)
	if err := Migrate(db); err != nil {
		t.Fatalf("migrate: %v", err)
	}

	index := func(table string) map[string]bool {
		var rows []map[string]any
		if err := db.Raw("PRAGMA index_list('" + table + "')").Scan(&rows).Error; err != nil {
			t.Fatalf("index_list %s: %v", table, err)
		}
		got := make(map[string]bool)
		for _, r := range rows {
			name, _ := r["name"].(string)
			unique := false
			switch v := r["unique"].(type) {
			case int64:
				unique = v == 1
			case bool:
				unique = v
			}
			got[strings.ToLower(name)] = unique
		}
		return got
	}

	sessions := index("w_game_sessions")
	if !sessions["uk_user_game"] {
		t.Errorf("w_game_sessions missing UNIQUE uk_user_game, got %v", sessions)
	}
	plays := index("w_game_plays")
	if !plays["uk_session"] {
		t.Errorf("w_game_plays missing UNIQUE uk_session, got %v", plays)
	}
	if _, ok := plays["idx_user_date"]; !ok {
		t.Errorf("w_game_plays missing idx_user_date, got %v", plays)
	}
	if plays["idx_user_date"] {
		t.Errorf("idx_user_date must NOT be unique (a user plays many times a day)")
	}
}

// TestGameSessionUniquePerUserGame 验证同一用户同一游戏只能有一局(AC4 的数据库地基)。
func TestGameSessionUniquePerUserGame(t *testing.T) {
	db := testDB(t)
	if err := Migrate(db); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	now := time.Now()
	first := &GameSession{ID: "a1", UserID: 1, GameType: "2048", Seed: "s1", StartedAt: now, ExpiresAt: now.Add(time.Hour)}
	if err := db.Create(first).Error; err != nil {
		t.Fatalf("insert first: %v", err)
	}
	second := &GameSession{ID: "a2", UserID: 1, GameType: "2048", Seed: "s2", StartedAt: now, ExpiresAt: now.Add(time.Hour)}
	if err := db.Create(second).Error; err == nil {
		t.Fatalf("expected uk_user_game to reject a second live session")
	}
	// 换个游戏就允许。
	other := &GameSession{ID: "a3", UserID: 1, GameType: "other", Seed: "s3", StartedAt: now, ExpiresAt: now.Add(time.Hour)}
	if err := db.Create(other).Error; err != nil {
		t.Fatalf("a different game should be allowed: %v", err)
	}
}

// TestGamePlayUniqueSession 验证同一 session 只能结算一次(AC3 的数据库地基)。
func TestGamePlayUniqueSession(t *testing.T) {
	db := testDB(t)
	if err := Migrate(db); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	one := &GamePlay{UserID: 1, GameType: "2048", SessionID: "sess1", PlayDate: "2026-08-20", Score: 100, HighestTile: 512, Moves: 20, Reason: "ok"}
	if err := db.Create(one).Error; err != nil {
		t.Fatalf("insert first: %v", err)
	}
	two := &GamePlay{UserID: 1, GameType: "2048", SessionID: "sess1", PlayDate: "2026-08-20", Score: 999, HighestTile: 2048, Moves: 30, Reason: "ok"}
	if err := db.Create(two).Error; err == nil {
		t.Fatalf("expected uk_session to reject a duplicate settlement")
	}
	// 同一用户同一天可以打很多局。
	three := &GamePlay{UserID: 1, GameType: "2048", SessionID: "sess2", PlayDate: "2026-08-20", Score: 50, HighestTile: 256, Moves: 10, Reason: "below_tier"}
	if err := db.Create(three).Error; err != nil {
		t.Fatalf("a second session on the same day should be allowed: %v", err)
	}
}

// TestDailyBudgetCompositeKey 验证 (date, scope) 复合主键。
func TestDailyBudgetCompositeKey(t *testing.T) {
	db := testDB(t)
	if err := Migrate(db); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	if err := db.Create(&DailyBudget{Date: "2026-08-20", Scope: "game", Used: 100}).Error; err != nil {
		t.Fatalf("insert: %v", err)
	}
	// 同日不同池、同池不同日都应允许。
	if err := db.Create(&DailyBudget{Date: "2026-08-20", Scope: "total", Used: 100}).Error; err != nil {
		t.Fatalf("same date other scope: %v", err)
	}
	if err := db.Create(&DailyBudget{Date: "2026-08-21", Scope: "game", Used: 0}).Error; err != nil {
		t.Fatalf("other date same scope: %v", err)
	}
	// 同日同池只能有一行。
	if err := db.Create(&DailyBudget{Date: "2026-08-20", Scope: "game", Used: 999}).Error; err == nil {
		t.Fatalf("expected composite primary key to reject a duplicate (date, scope) row")
	}
}
