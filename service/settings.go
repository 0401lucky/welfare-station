package service

import (
	"encoding/json"
	"errors"
	"fmt"
	"sort"
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

// ---- 游戏与预算配置(game_config)----

// GameTier 是一档奖励:本局最高方块达到 Tile 即可拿 Quota 额度(整数口径)。
type GameTier struct {
	Tile  int   `json:"tile"`  // 达到该方块
	Quota int64 `json:"quota"` // 发放额度(整数)
}

// GameRules 是单个游戏的规则,与具体游戏解耦,加新游戏只需在 Games 里多一个键。
type GameRules struct {
	Enabled         bool       `json:"enabled"`
	RewardType      string     `json:"reward_type"`       // permanent | temporary
	DailyClaimLimit int        `json:"daily_claim_limit"` // 每人每日领奖次数
	UserDailyCap    int64      `json:"user_daily_cap"`    // 每人每日额度上限
	CooldownSeconds int        `json:"cooldown_seconds"`
	Tiers           []GameTier `json:"tiers"` // 保存时按 tile 升序归一化
}

// BudgetRule 是一个每日预算池的开关与额度。用量记在 w_daily_budgets,
// 上限只存配置,改配置立即生效。
type BudgetRule struct {
	Enabled bool  `json:"enabled"`
	Daily   int64 `json:"daily"` // 每日预算(整数)
}

// GameConfig 是游戏注册表 + 预算池注册表(design.md §4)。
type GameConfig struct {
	Timezone string                `json:"timezone"` // 跨日重置基准,默认 Asia/Shanghai
	Games    map[string]GameRules  `json:"games"`    // key = GameType,如 "2048"
	Budgets  map[string]BudgetRule `json:"budgets"`  // key = total|game|checkin|activity
}

const GameConfigKey = "game_config"

// 预算池 scope(w_daily_budgets.scope):total 是全站总闸,其余按发放来源分池。
const (
	BudgetScopeTotal    = "total"
	BudgetScopeGame     = "game"
	BudgetScopeCheckin  = "checkin"
	BudgetScopeActivity = "activity"
)

// BudgetScopes 是允许的池名,配置里出现其他 scope 一律拒绝。
var BudgetScopes = []string{BudgetScopeTotal, BudgetScopeGame, BudgetScopeCheckin, BudgetScopeActivity}

// defaultGameTimezone 是时区缺失或非法时的回落值。
const defaultGameTimezone = "Asia/Shanghai"

// gameType2048 与 game2048.GameType2048 取值一致;这里只是配置表的键,
// 不引入引擎包依赖。
const gameType2048 = "2048"

// DefaultGameConfig returns the schema with design.md §4 default values.
func DefaultGameConfig() *GameConfig {
	return &GameConfig{
		Timezone: defaultGameTimezone,
		Games: map[string]GameRules{
			gameType2048: {
				Enabled:         true,
				RewardType:      QuotaTypePermanent,
				DailyClaimLimit: 3,
				UserDailyCap:    150000,
				CooldownSeconds: 5,
				Tiers: []GameTier{
					{Tile: 512, Quota: 10000},
					{Tile: 1024, Quota: 25000},
					{Tile: 2048, Quota: 100000},
					{Tile: 4096, Quota: 250000},
				},
			},
		},
		Budgets: map[string]BudgetRule{
			BudgetScopeTotal:    {Enabled: false, Daily: 0},
			BudgetScopeGame:     {Enabled: true, Daily: 10000000},
			BudgetScopeCheckin:  {Enabled: false, Daily: 25000000},
			BudgetScopeActivity: {Enabled: false, Daily: 0},
		},
	}
}

// GetGameConfig loads game_config, seeding defaults on first run.
// 缺失字段一律零值兜底,不因字段不存在而报错:部署顺序上前端/配置可能旧于后端。
func GetGameConfig(db *gorm.DB) (*GameConfig, error) {
	raw, err := GetSetting(db, GameConfigKey)
	if err != nil {
		return nil, err
	}
	if raw == "" {
		def := DefaultGameConfig()
		// 默认值是已知合法的,直接落库,不走校验。
		if err := persistGameConfig(db, def); err != nil {
			return nil, err
		}
		return def, nil
	}
	var c GameConfig
	if err := json.Unmarshal([]byte(raw), &c); err != nil {
		return nil, err
	}
	// 缺 games / budgets 的旧配置读出来是 nil map,调用方按「该游戏未启用 /
	// 该池未开启」解释即可,这里只保证读写不 panic。
	if c.Games == nil {
		c.Games = map[string]GameRules{}
	}
	if c.Budgets == nil {
		c.Budgets = map[string]BudgetRule{}
	}
	for name, r := range c.Games {
		// 空值/未知值按永久额度解释,与 checkin_config 一致。
		r.RewardType = NormalizeQuotaType(r.RewardType)
		c.Games[name] = r
	}
	// 时区缺失时回落默认值,否则日界会退化成 UTC,预算与对局日期都会错位。
	if c.Timezone == "" {
		c.Timezone = defaultGameTimezone
	}
	return &c, nil
}

// SaveGameConfig validates and persists game_config。
// maxGrantQuota 传 cfg.MaxGrantQuota,用来挡住手滑配出的天价奖励。
func SaveGameConfig(db *gorm.DB, c *GameConfig, maxGrantQuota int64) error {
	if c.Timezone == "" {
		c.Timezone = defaultGameTimezone
	}
	if _, err := time.LoadLocation(c.Timezone); err != nil {
		// 非法时区不报错,回落默认值(与 TodayStr 的容错方向一致)。
		c.Timezone = defaultGameTimezone
	}

	for name, r := range c.Games {
		// 空值(旧前端不带该字段)视为永久额度;其他非法取值直接拒绝。
		if r.RewardType == "" {
			r.RewardType = QuotaTypePermanent
		}
		if r.RewardType != QuotaTypePermanent && r.RewardType != QuotaTypeTemporary {
			return fmt.Errorf("游戏 %s 的 reward_type 必须是 permanent 或 temporary", name)
		}
		if r.DailyClaimLimit < 0 {
			return fmt.Errorf("游戏 %s 的 daily_claim_limit 不能为负", name)
		}
		if r.UserDailyCap < 0 {
			return fmt.Errorf("游戏 %s 的 user_daily_cap 不能为负", name)
		}
		if r.CooldownSeconds < 0 || r.CooldownSeconds > 3600 {
			return fmt.Errorf("游戏 %s 的 cooldown_seconds 必须在 0~3600 之间", name)
		}
		for _, t := range r.Tiers {
			if !isPowerOfTwoTile(t.Tile) {
				return fmt.Errorf("游戏 %s 的奖励档位 tile=%d 必须是 2 的幂且不小于 2", name, t.Tile)
			}
			if t.Quota < 0 {
				return fmt.Errorf("游戏 %s 的奖励档位 tile=%d 的 quota 不能为负", name, t.Tile)
			}
			if t.Quota > maxGrantQuota {
				return fmt.Errorf("游戏 %s 的奖励档位 tile=%d 的 quota 超过单次发放上限 %d", name, t.Tile, maxGrantQuota)
			}
		}
		// 归一化:按 tile 升序存,MatchTier 依赖这个顺序。
		sort.SliceStable(r.Tiers, func(i, j int) bool { return r.Tiers[i].Tile < r.Tiers[j].Tile })
		c.Games[name] = r
	}

	for scope, b := range c.Budgets {
		if !isKnownBudgetScope(scope) {
			return fmt.Errorf("未知的预算池 %s", scope)
		}
		if b.Daily < 0 {
			return fmt.Errorf("预算池 %s 的 daily 不能为负", scope)
		}
		// checkin / activity 两个池的配置结构已经就位,但 DoCheckin 与活动领取
		// **尚未调用 TryConsume**,开了也不会有任何拦截效果。
		//
		// 这里主动拒绝启用,而不是放任存库:否则站长在后台打开开关、填上金额,
		// 界面显示「已用 $0 / 预算 $50」,而签到该发多少还是发多少——一个会骗人的
		// 开关比没有开关更糟。接入发放链路时删掉这个分支即可。
		if b.Enabled && !isWiredBudgetScope(scope) {
			return fmt.Errorf("预算池 %s 尚未接入发放链路,暂不可启用", scope)
		}
	}

	return persistGameConfig(db, c)
}

// persistGameConfig marshals and upserts the config row.
func persistGameConfig(db *gorm.DB, c *GameConfig) error {
	b, err := json.Marshal(c)
	if err != nil {
		return err
	}
	return SetSetting(db, GameConfigKey, string(b))
}

// isPowerOfTwoTile 判断档位是否为 ≥2 的 2 的幂(2048 的方块面值)。
func isPowerOfTwoTile(tile int) bool {
	return tile >= 2 && tile&(tile-1) == 0
}

// isKnownBudgetScope 判断池名是否在白名单内。
func isKnownBudgetScope(scope string) bool {
	for _, s := range BudgetScopes {
		if s == scope {
			return true
		}
	}
	return false
}

// WiredBudgetScopes 是**真正接入了发放链路**的预算池。
//
// 与 BudgetScopes 的区别:后者是配置结构上认识的池名,前者是实际会被 TryConsume
// 扣减的池。checkin / activity 目前只有配置没有接入,因此不在此列——把两者分开,
// 前端才能如实告诉站长哪些开关是有效的。接入后把对应 scope 加进来即可。
var WiredBudgetScopes = []string{BudgetScopeTotal, BudgetScopeGame}

// isWiredBudgetScope 判断该池是否已接入发放链路(即开了之后真的会拦)。
func isWiredBudgetScope(scope string) bool {
	for _, s := range WiredBudgetScopes {
		if s == scope {
			return true
		}
	}
	return false
}

// MatchTier 返回该最高方块命中的最高奖励档。tiers 已按 tile 升序。
// 同一局只发这一档,不累加下面的档。
func MatchTier(tiers []GameTier, highestTile int) (GameTier, bool) {
	var hit GameTier
	found := false
	for _, t := range tiers {
		if highestTile >= t.Tile {
			hit, found = t, true
		}
	}
	return hit, found
}
