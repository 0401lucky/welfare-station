package service

import (
	"encoding/json"
	"errors"
	"time"

	"welfare/model"

	"gorm.io/gorm"
)

// CheckinConfig mirrors design.md §3 checkin_config JSON structure.
type StreakBonus struct {
	Days  int     `json:"days"`
	Bonus float64 `json:"bonus"`
}

type CheckinConfig struct {
	Enabled  bool   `json:"enabled"`
	Timezone string `json:"timezone"`
	Mode     string `json:"mode"` // "fixed" | "random"
	// RewardType 奖励类型:"permanent"(永久余额,默认)/ "temporary"(今日限时额度)。
	// 存量配置没有这个字段,读取时按 permanent 兜底。
	RewardType    string        `json:"reward_type"`
	FixedQuota    int64         `json:"fixed_quota"`
	MinQuota      int64         `json:"min_quota"`
	MaxQuota      int64         `json:"max_quota"`
	StreakBonuses []StreakBonus `json:"streak_bonuses"`
	MinTrustLevel int           `json:"min_trust_level"` // optional global trust gate (default 0)
	// AvailableFromMinutes 签到开放时间:当日零点后的分钟数(与 new-api 的
	// checkin_setting.available_from_minutes 语义一致),按 Timezone 判断。
	// 0 = 不限制;存量配置没有这个字段,读取时为 0,行为不变。
	AvailableFromMinutes int `json:"available_from_minutes"`
}

const CheckinConfigKey = "checkin_config"

// DefaultCheckinConfig returns the schema with design.md default values.
func DefaultCheckinConfig() *CheckinConfig {
	return &CheckinConfig{
		Enabled:    true,
		Timezone:   "Asia/Shanghai",
		Mode:       "random",
		RewardType: QuotaTypePermanent,
		FixedQuota: 100000,
		MinQuota:   50000,
		MaxQuota:   200000,
		StreakBonuses: []StreakBonus{
			{Days: 3, Bonus: 0.10},
			{Days: 7, Bonus: 0.25},
			{Days: 30, Bonus: 0.50},
		},
		MinTrustLevel:        0,
		AvailableFromMinutes: 0,
	}
}

// GetSetting reads a setting row as raw JSON string. Returns ("", nil) when absent.
func GetSetting(db *gorm.DB, key string) (string, error) {
	var s model.Setting
	err := db.Where("`key` = ?", key).First(&s).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	return s.Value, nil
}

// SetSetting writes a setting row (upsert).
func SetSetting(db *gorm.DB, key, value string) error {
	now := time.Now()
	s := model.Setting{Key: key, Value: value, UpdatedAt: now}
	// Upsert: rely on primary key; insert or update on duplicate.
	return db.Save(&s).Error
}

// GetCheckinConfig loads checkin_config, seeding defaults on first run.
func GetCheckinConfig(db *gorm.DB) (*CheckinConfig, error) {
	raw, err := GetSetting(db, CheckinConfigKey)
	if err != nil {
		return nil, err
	}
	if raw == "" {
		def := DefaultCheckinConfig()
		if err := SaveCheckinConfig(db, def); err != nil {
			return nil, err
		}
		return def, nil
	}
	var c CheckinConfig
	if err := json.Unmarshal([]byte(raw), &c); err != nil {
		return nil, err
	}
	// 存量配置无 reward_type,按永久额度解释。
	c.RewardType = NormalizeQuotaType(c.RewardType)
	return &c, nil
}

// SaveCheckinConfig validates and persists checkin_config.
func SaveCheckinConfig(db *gorm.DB, c *CheckinConfig) error {
	if c.Mode != "fixed" && c.Mode != "random" {
		return errors.New("mode must be fixed or random")
	}
	// 空值(旧前端不带该字段)视为永久额度;其他非法取值直接拒绝。
	if c.RewardType == "" {
		c.RewardType = QuotaTypePermanent
	}
	if c.RewardType != QuotaTypePermanent && c.RewardType != QuotaTypeTemporary {
		return errors.New("reward_type must be permanent or temporary")
	}
	if c.Timezone == "" {
		c.Timezone = "Asia/Shanghai"
	}
	if c.FixedQuota < 0 || c.MinQuota < 0 || c.MaxQuota < c.MinQuota {
		return errors.New("invalid quota range")
	}
	if c.StreakBonuses == nil {
		c.StreakBonuses = DefaultCheckinConfig().StreakBonuses
	}
	// 开放时间必须落在一天之内;0 表示不限制。
	if c.AvailableFromMinutes < 0 || c.AvailableFromMinutes > 1439 {
		return errors.New("available_from_minutes must be between 0 and 1439")
	}
	b, err := json.Marshal(c)
	if err != nil {
		return err
	}
	return SetSetting(db, CheckinConfigKey, string(b))
}
