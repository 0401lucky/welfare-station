// Package feedbacktest contains opt-in, disposable database fixtures only.
package feedbacktest

import (
	"crypto/rand"
	"encoding/hex"
	"net"
	"os"
	"testing"

	mysqldriver "github.com/go-sql-driver/mysql"
	"gorm.io/driver/mysql"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
)

// MySQL requires an explicit loopback-only disposable test DSN. Every caller
// creates its own random database, so `go test ./...` packages cannot collide.
// It never opens DB_DSN or a production .env, nor drops the supplied database.
func MySQL(t *testing.T) *gorm.DB {
	t.Helper()
	dsn := os.Getenv("FEEDBACK_TEST_MYSQL_DSN")
	if dsn == "" {
		t.Skip("FEEDBACK_TEST_MYSQL_DSN absent; disposable MySQL verification not run")
	}
	cfg, err := mysqldriver.ParseDSN(dsn)
	if err != nil {
		t.Fatal("invalid disposable MySQL DSN")
	}
	host, _, err := net.SplitHostPort(cfg.Addr)
	if err != nil || cfg.Net != "tcp" || (host != "127.0.0.1" && host != "localhost" && host != "::1") || cfg.DBName != "feedback_v2_test" {
		t.Fatal("MySQL tests require loopback tcp and database exactly feedback_v2_test")
	}
	open := func(config *mysqldriver.Config) *gorm.DB {
		db, err := gorm.Open(mysql.Open(config.FormatDSN()), &gorm.Config{Logger: logger.Default.LogMode(logger.Silent)})
		if err != nil {
			t.Fatal("cannot connect to disposable MySQL fixture")
		}
		return db
	}
	base := open(cfg)
	baseSQL, err := base.DB()
	if err != nil {
		t.Fatal(err)
	}
	nameBytes := make([]byte, 8)
	if _, err := rand.Read(nameBytes); err != nil {
		t.Fatal(err)
	}
	name := "feedback_v2_test_" + hex.EncodeToString(nameBytes)
	if err := base.Exec("CREATE DATABASE " + name + " CHARACTER SET utf8mb4").Error; err != nil {
		baseSQL.Close()
		t.Fatal("cannot create isolated MySQL test database")
	}
	t.Cleanup(func() {
		if err := base.Exec("DROP DATABASE " + name).Error; err != nil {
			t.Error("cannot remove owned isolated MySQL test database")
		}
		baseSQL.Close()
	})
	cfg.DBName, cfg.ParseTime = name, true
	db := open(cfg)
	sqlDB, err := db.DB()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { sqlDB.Close() })
	return db
}
