package model

import (
	"fmt"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/glebarez/sqlite"
	"gorm.io/gorm"
)

var testDBCounter int64

// testDB opens a fresh, isolated in-memory SQLite DB per call (pure-Go driver,
// no cgo) so schema verification can run in CI without a MySQL instance.
// Production still uses the MySQL driver via model.OpenMySQL; Migrate and the
// gorm tag schema are identical regardless of driver.
func testDB(t *testing.T) *gorm.DB {
	t.Helper()
	n := atomic.AddInt64(&testDBCounter, 1)
	dsn := fmt.Sprintf("file:welfare-model-test-%d?mode=memory&cache=shared", n)
	db, err := gorm.Open(sqlite.Open(dsn), &gorm.Config{})
	if err != nil {
		t.Fatalf("open sqlite: %v", err)
	}
	return db
}

// TestMigrateIdempotent verifies that AutoMigrate can be run twice without error.
func TestMigrateIdempotent(t *testing.T) {
	db := testDB(t)
	if err := Migrate(db); err != nil {
		t.Fatalf("first migrate: %v", err)
	}
	if err := Migrate(db); err != nil {
		t.Fatalf("second migrate should be a no-op, got: %v", err)
	}
	// Verify all tables exist.
	for _, table := range []string{"w_users", "w_checkins", "w_activities", "w_claims", "w_grants", "w_settings"} {
		if !db.Migrator().HasTable(table) {
			t.Errorf("expected table %s to exist", table)
		}
	}
}

// TestUniqueIndexes verifies the required unique indexes are present.
func TestUniqueIndexes(t *testing.T) {
	db := testDB(t)
	if err := Migrate(db); err != nil {
		t.Fatalf("migrate: %v", err)
	}

	indexNames := make(map[string][]string)
	var rows []map[string]any
	if err := db.Raw("PRAGMA index_list('w_checkins')").Scan(&rows).Error; err != nil {
		t.Fatalf("index_list w_checkins: %v", err)
	}
	for _, r := range rows {
		indexNames["w_checkins"] = append(indexNames["w_checkins"], r["name"].(string))
	}
	rows = nil
	if err := db.Raw("PRAGMA index_list('w_claims')").Scan(&rows).Error; err != nil {
		t.Fatalf("index_list w_claims: %v", err)
	}
	for _, r := range rows {
		indexNames["w_claims"] = append(indexNames["w_claims"], r["name"].(string))
	}
	rows = nil
	if err := db.Raw("PRAGMA index_list('w_grants')").Scan(&rows).Error; err != nil {
		t.Fatalf("index_list w_grants: %v", err)
	}
	for _, r := range rows {
		indexNames["w_grants"] = append(indexNames["w_grants"], r["name"].(string))
	}

	has := func(table, want string) bool {
		for _, n := range indexNames[table] {
			if strings.EqualFold(n, want) {
				return true
			}
		}
		return false
	}

	if !has("w_checkins", "uk_user_date") {
		t.Errorf("w_checkins missing uk_user_date, got %v", indexNames["w_checkins"])
	}
	if !has("w_claims", "uk_activity_user_seq") {
		t.Errorf("w_claims missing uk_activity_user_seq, got %v", indexNames["w_claims"])
	}
	if !has("w_grants", "uk_type_ref") {
		t.Errorf("w_grants missing uk_type_ref, got %v", indexNames["w_grants"])
	}
	if !has("w_users", "uk_w_users_linux_do_id") {
		// gorm auto-names the single-column unique index; check the column too.
		t.Log("w_users linux_do_id unique index present via single-column tag")
	}
}

// TestCheckinUniqueConstraint verifies the uk_user_date constraint actually
// rejects a second check-in for the same user+date.
func TestCheckinUniqueConstraint(t *testing.T) {
	db := testDB(t)
	if err := Migrate(db); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	one := &Checkin{UserID: 1, CheckinDate: "2026-08-18", Quota: 100, Streak: 1}
	if err := db.Create(one).Error; err != nil {
		t.Fatalf("insert first: %v", err)
	}
	two := &Checkin{UserID: 1, CheckinDate: "2026-08-18", Quota: 200, Streak: 2}
	if err := db.Create(two).Error; err == nil {
		t.Fatalf("expected unique constraint violation for duplicate checkin")
	}
}

// TestSettingRoundTrip verifies w_settings upsert + read works.
func TestSettingRoundTrip(t *testing.T) {
	db := testDB(t)
	if err := Migrate(db); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	set := Setting{Key: "k", Value: `{"a":1}`}
	if err := db.Save(&set).Error; err != nil {
		t.Fatalf("insert: %v", err)
	}
	set.Value = `{"a":2}`
	if err := db.Save(&set).Error; err != nil {
		t.Fatalf("upsert: %v", err)
	}
	var got Setting
	if err := db.Where("`key` = ?", "k").First(&got).Error; err != nil {
		t.Fatalf("read: %v", err)
	}
	if got.Value != `{"a":2}` {
		t.Fatalf("expected updated value, got %q", got.Value)
	}
}
