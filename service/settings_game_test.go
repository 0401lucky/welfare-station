package service

import (
	"strings"
	"testing"
)

const testMaxGrantQuota = int64(5000000)

// TestMatchTier 覆盖 design.md §5:只发命中的最高一档,不累加。
func TestMatchTier(t *testing.T) {
	tiers := []GameTier{
		{Tile: 512, Quota: 10000},
		{Tile: 1024, Quota: 25000},
		{Tile: 2048, Quota: 100000},
		{Tile: 4096, Quota: 250000},
	}
	cases := []struct {
		name        string
		tiers       []GameTier
		highestTile int
		wantFound   bool
		wantQuota   int64
	}{
		{"未达最低档", tiers, 256, false, 0},
		{"正好等于最低档", tiers, 512, true, 10000},
		{"落在两档之间取低的那档", tiers, 1500, true, 25000},
		{"正好等于最高档", tiers, 4096, true, 250000},
		{"超过最高档仍只发最高档", tiers, 8192, true, 250000},
		{"空档位表不发奖", nil, 8192, false, 0},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			hit, ok := MatchTier(tc.tiers, tc.highestTile)
			if ok != tc.wantFound {
				t.Fatalf("found: got %v, want %v", ok, tc.wantFound)
			}
			if hit.Quota != tc.wantQuota {
				t.Fatalf("quota: got %d, want %d", hit.Quota, tc.wantQuota)
			}
		})
	}
}

// TestGetGameConfigSeedsDefaults 验证首次读取会把默认配置落库。
func TestGetGameConfigSeedsDefaults(t *testing.T) {
	db := grantDB(t)

	cfg, err := GetGameConfig(db)
	if err != nil {
		t.Fatalf("first read: %v", err)
	}
	if cfg.Timezone != "Asia/Shanghai" {
		t.Errorf("timezone: got %q, want Asia/Shanghai", cfg.Timezone)
	}
	rules, ok := cfg.Games["2048"]
	if !ok {
		t.Fatalf("default config should register game 2048, got %v", cfg.Games)
	}
	if !rules.Enabled || rules.DailyClaimLimit != 3 || rules.UserDailyCap != 150000 || rules.CooldownSeconds != 5 {
		t.Errorf("unexpected default rules: %+v", rules)
	}
	if len(rules.Tiers) != 4 || rules.Tiers[0].Tile != 512 || rules.Tiers[3].Quota != 250000 {
		t.Errorf("unexpected default tiers: %+v", rules.Tiers)
	}
	if b := cfg.Budgets[BudgetScopeGame]; !b.Enabled || b.Daily != 10000000 {
		t.Errorf("game budget should default to enabled/10000000, got %+v", b)
	}
	for _, scope := range []string{BudgetScopeTotal, BudgetScopeCheckin, BudgetScopeActivity} {
		if cfg.Budgets[scope].Enabled {
			t.Errorf("budget %s should default to disabled", scope)
		}
	}

	// 落库后再读一次必须走反序列化分支,结果一致。
	raw, err := GetSetting(db, GameConfigKey)
	if err != nil || raw == "" {
		t.Fatalf("defaults should have been persisted, raw=%q err=%v", raw, err)
	}
	again, err := GetGameConfig(db)
	if err != nil {
		t.Fatalf("second read: %v", err)
	}
	if again.Games["2048"].UserDailyCap != 150000 {
		t.Errorf("second read lost values: %+v", again.Games["2048"])
	}
}

// TestGetGameConfigLegacyJSON 验证旧配置缺字段时不报错,缺的就是零值
// (部署顺序上配置可能旧于后端,这是 spec 的硬约束)。
func TestGetGameConfigLegacyJSON(t *testing.T) {
	db := grantDB(t)
	// 一份只有游戏开关的旧配置:没有 timezone / budgets / reward_type / tiers。
	if err := SetSetting(db, GameConfigKey, `{"games":{"2048":{"enabled":true}}}`); err != nil {
		t.Fatalf("seed legacy json: %v", err)
	}

	cfg, err := GetGameConfig(db)
	if err != nil {
		t.Fatalf("legacy config must not error: %v", err)
	}
	rules := cfg.Games["2048"]
	if !rules.Enabled {
		t.Errorf("enabled should survive: %+v", rules)
	}
	if rules.RewardType != QuotaTypePermanent {
		t.Errorf("missing reward_type should read as permanent, got %q", rules.RewardType)
	}
	if rules.DailyClaimLimit != 0 || rules.UserDailyCap != 0 || rules.CooldownSeconds != 0 || rules.Tiers != nil {
		t.Errorf("missing fields should be zero values, got %+v", rules)
	}
	// 缺 budgets 的存量配置读出来只应含 draw 一个键:draw 池由 GetGameConfig 主动
	// 补齐(理由见该处注释——drawBudgetRules 对缺键会按保底值真扣预算,不补齐会让
	// 后台显示成「未开启、不受限额约束」,与实际行为相反)。其余池仍保持「缺就是缺」。
	if cfg.Budgets == nil || len(cfg.Budgets) != 1 {
		t.Errorf("missing budgets should read as draw-only map, got %v", cfg.Budgets)
	}
	if _, ok := cfg.Budgets[BudgetScopeDraw]; !ok {
		t.Errorf("draw 池必须被补齐,否则后台预算页会骗人, got %v", cfg.Budgets)
	}
	if cfg.Timezone != "Asia/Shanghai" {
		t.Errorf("missing timezone should fall back to Asia/Shanghai, got %q", cfg.Timezone)
	}

	// 空对象同样不能报错。
	if err := SetSetting(db, GameConfigKey, `{}`); err != nil {
		t.Fatalf("seed empty json: %v", err)
	}
	if _, err := GetGameConfig(db); err != nil {
		t.Fatalf("empty config must not error: %v", err)
	}
}

// TestSaveGameConfigSortsTiers 验证乱序档位存进去后是升序(MatchTier 依赖该顺序)。
func TestSaveGameConfigSortsTiers(t *testing.T) {
	db := grantDB(t)
	cfg := DefaultGameConfig()
	rules := cfg.Games["2048"]
	rules.Tiers = []GameTier{
		{Tile: 2048, Quota: 100000},
		{Tile: 512, Quota: 10000},
		{Tile: 4096, Quota: 250000},
		{Tile: 1024, Quota: 25000},
	}
	cfg.Games["2048"] = rules

	if err := SaveGameConfig(db, cfg, testMaxGrantQuota); err != nil {
		t.Fatalf("save: %v", err)
	}
	got, err := GetGameConfig(db)
	if err != nil {
		t.Fatalf("read back: %v", err)
	}
	want := []int{512, 1024, 2048, 4096}
	saved := got.Games["2048"].Tiers
	if len(saved) != len(want) {
		t.Fatalf("tier count: got %d, want %d", len(saved), len(want))
	}
	for i, tile := range want {
		if saved[i].Tile != tile {
			t.Errorf("tier[%d]: got %d, want %d (tiers must be stored ascending)", i, saved[i].Tile, tile)
		}
	}
}

// TestSaveGameConfigValidation 覆盖 design.md §4 的全部保存校验。
func TestSaveGameConfigValidation(t *testing.T) {
	cases := []struct {
		name    string
		mutate  func(*GameConfig)
		wantErr string // 期望错误信息包含的片段;空串表示应当保存成功
	}{
		{
			name:    "tile 不是 2 的幂被拒",
			mutate:  func(c *GameConfig) { setTiers(c, []GameTier{{Tile: 1000, Quota: 10000}}) },
			wantErr: "tile=1000",
		},
		{
			name:    "tile 小于 2 被拒",
			mutate:  func(c *GameConfig) { setTiers(c, []GameTier{{Tile: 1, Quota: 10000}}) },
			wantErr: "tile=1",
		},
		{
			name:    "quota 超过单次发放上限被拒",
			mutate:  func(c *GameConfig) { setTiers(c, []GameTier{{Tile: 2048, Quota: testMaxGrantQuota + 1}}) },
			wantErr: "超过单次发放上限",
		},
		{
			name:    "quota 为负被拒",
			mutate:  func(c *GameConfig) { setTiers(c, []GameTier{{Tile: 2048, Quota: -1}}) },
			wantErr: "quota 不能为负",
		},
		{
			name:    "非法 reward_type 被拒",
			mutate:  func(c *GameConfig) { setRules(c, func(r *GameRules) { r.RewardType = "bonus" }) },
			wantErr: "reward_type",
		},
		{
			name:    "daily_claim_limit 为负被拒",
			mutate:  func(c *GameConfig) { setRules(c, func(r *GameRules) { r.DailyClaimLimit = -1 }) },
			wantErr: "daily_claim_limit",
		},
		{
			name:    "user_daily_cap 为负被拒",
			mutate:  func(c *GameConfig) { setRules(c, func(r *GameRules) { r.UserDailyCap = -1 }) },
			wantErr: "user_daily_cap",
		},
		{
			name:    "cooldown_seconds 超过 3600 被拒",
			mutate:  func(c *GameConfig) { setRules(c, func(r *GameRules) { r.CooldownSeconds = 3601 }) },
			wantErr: "cooldown_seconds",
		},
		{
			name:    "未知预算池被拒",
			mutate:  func(c *GameConfig) { c.Budgets["lottery"] = BudgetRule{Enabled: true, Daily: 100} },
			wantErr: "未知的预算池",
		},
		{
			name:    "预算为负被拒",
			mutate:  func(c *GameConfig) { c.Budgets[BudgetScopeGame] = BudgetRule{Enabled: true, Daily: -1} },
			wantErr: "daily 不能为负",
		},
		{
			name:    "空档位表允许(等于不发奖)",
			mutate:  func(c *GameConfig) { setTiers(c, nil) },
			wantErr: "",
		},
		{
			name:    "quota 正好等于上限允许",
			mutate:  func(c *GameConfig) { setTiers(c, []GameTier{{Tile: 2048, Quota: testMaxGrantQuota}}) },
			wantErr: "",
		},
		{
			name:    "空 reward_type 按永久额度放行",
			mutate:  func(c *GameConfig) { setRules(c, func(r *GameRules) { r.RewardType = "" }) },
			wantErr: "",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			db := grantDB(t)
			cfg := DefaultGameConfig()
			tc.mutate(cfg)
			err := SaveGameConfig(db, cfg, testMaxGrantQuota)
			if tc.wantErr == "" {
				if err != nil {
					t.Fatalf("should be accepted, got: %v", err)
				}
				return
			}
			if err == nil {
				t.Fatalf("should be rejected, got nil error")
			}
			if !strings.Contains(err.Error(), tc.wantErr) {
				t.Fatalf("error should mention %q, got: %v", tc.wantErr, err)
			}
			// 被拒的配置不能落库。
			if raw, _ := GetSetting(db, GameConfigKey); raw != "" {
				t.Errorf("rejected config must not be persisted, got %q", raw)
			}
		})
	}
}

// TestSaveGameConfigTimezoneFallback 验证非法/缺失时区回落 Asia/Shanghai 而不是报错。
func TestSaveGameConfigTimezoneFallback(t *testing.T) {
	for _, tz := range []string{"", "Mars/Olympus"} {
		db := grantDB(t)
		cfg := DefaultGameConfig()
		cfg.Timezone = tz
		if err := SaveGameConfig(db, cfg, testMaxGrantQuota); err != nil {
			t.Fatalf("timezone %q should fall back, got: %v", tz, err)
		}
		got, err := GetGameConfig(db)
		if err != nil {
			t.Fatalf("read back: %v", err)
		}
		if got.Timezone != "Asia/Shanghai" {
			t.Errorf("timezone %q should fall back to Asia/Shanghai, got %q", tz, got.Timezone)
		}
	}
}

// TestSaveGameConfigNormalizesRewardType 验证空 reward_type 存成 permanent。
func TestSaveGameConfigNormalizesRewardType(t *testing.T) {
	db := grantDB(t)
	cfg := DefaultGameConfig()
	setRules(cfg, func(r *GameRules) { r.RewardType = "" })
	if err := SaveGameConfig(db, cfg, testMaxGrantQuota); err != nil {
		t.Fatalf("save: %v", err)
	}
	got, err := GetGameConfig(db)
	if err != nil {
		t.Fatalf("read back: %v", err)
	}
	if got.Games["2048"].RewardType != QuotaTypePermanent {
		t.Errorf("empty reward_type should be stored as permanent, got %q", got.Games["2048"].RewardType)
	}
}

// setTiers / setRules 是改默认配置里 2048 那一项的小工具(map 里的 struct 不能直接改字段)。
func setTiers(c *GameConfig, tiers []GameTier) {
	setRules(c, func(r *GameRules) { r.Tiers = tiers })
}

func setRules(c *GameConfig, fn func(*GameRules)) {
	r := c.Games["2048"]
	fn(&r)
	c.Games["2048"] = r
}

// TestSaveGameConfigRejectsUnwiredPool 锁住「尚未接入的预算池不可启用」。
//
// checkin / activity 的配置结构已就位,但 DoCheckin 与活动领取还没调 TryConsume,
// 开了不会有任何拦截效果。允许存库就等于给站长一个会骗人的开关:界面显示
// 「已用 $0 / 预算 $50」,而签到该发多少还是发多少。接入后删掉该校验并改本用例。
func TestSaveGameConfigRejectsUnwiredPool(t *testing.T) {
	db := grantDB(t)
	for _, scope := range []string{BudgetScopeCheckin, BudgetScopeActivity} {
		cfg := DefaultGameConfig()
		cfg.Budgets[scope] = BudgetRule{Enabled: true, Daily: 1000}
		if err := SaveGameConfig(db, cfg, 5000000); err == nil {
			t.Fatalf("启用尚未接入的池 %s 必须被拒", scope)
		}
		// 关着可以存,金额也能先填好(占位)。
		cfg.Budgets[scope] = BudgetRule{Enabled: false, Daily: 1000}
		if err := SaveGameConfig(db, cfg, 5000000); err != nil {
			t.Fatalf("关闭状态下的 %s 应当允许保存: %v", scope, err)
		}
	}
	// 已接入的两个池不受影响。
	cfg := DefaultGameConfig()
	cfg.Budgets[BudgetScopeGame] = BudgetRule{Enabled: true, Daily: 1000}
	cfg.Budgets[BudgetScopeTotal] = BudgetRule{Enabled: true, Daily: 2000}
	if err := SaveGameConfig(db, cfg, 5000000); err != nil {
		t.Fatalf("已接入的池应当可以启用: %v", err)
	}
}
