package model

import (
	"fmt"
	"log"
	"strings"

	"github.com/glebarez/sqlite"
	"gorm.io/driver/mysql"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
)

// Open opens a gorm connection. Production uses MySQL ("mysql", design.md §11);
// "sqlite" is supported for local development and testing without a MySQL box.
func Open(driver, dsn string) (*gorm.DB, error) {
	if driver == "sqlite" {
		db, err := gorm.Open(sqlite.Open(dsn), &gorm.Config{
			Logger: logger.Default.LogMode(logger.Warn),
		})
		if err != nil {
			return nil, fmt.Errorf("open sqlite: %w", err)
		}
		return db, nil
	}
	db, err := gorm.Open(mysql.Open(dsn), &gorm.Config{
		Logger: logger.Default.LogMode(logger.Warn),
	})
	if err != nil {
		return nil, fmt.Errorf("open mysql: %w", err)
	}
	sqlDB, err := db.DB()
	if err != nil {
		return nil, fmt.Errorf("get underlying sql db: %w", err)
	}
	if err := sqlDB.Ping(); err != nil {
		return nil, fmt.Errorf("ping mysql: %w", err)
	}
	sqlDB.SetMaxOpenConns(20)
	sqlDB.SetMaxIdleConns(5)
	return db, nil
}

// tableNames 从 AllModels() 派生实际迁移的表名。此前这里是硬编码的 6 张表名,
// 新增模型后日志会漏报(游戏相关三张表就撞上过),派生出来才不会再脱节。
func tableNames() []string {
	type tabler interface{ TableName() string }
	models := AllModels()
	names := make([]string, 0, len(models))
	for _, m := range models {
		if t, ok := m.(tabler); ok {
			names = append(names, t.TableName())
		}
	}
	return names
}

// Migrate runs AutoMigrate for all models. It is idempotent: re-running the
// same schema on an existing database produces no migration error.
func Migrate(db *gorm.DB) error {
	if err := db.AutoMigrate(AllModels()...); err != nil {
		return fmt.Errorf("auto migrate: %w", err)
	}
	log.Printf("database schema is up to date (tables %s)", strings.Join(tableNames(), ", "))
	return nil
}
