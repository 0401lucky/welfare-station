package service

import (
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"time"

	"gorm.io/gorm"
)

// ---- 每日幸运抽奖配置(draw_config)----
//
// 抽奖是「服务端版签到」:每人每天一次,服务端摇一个 1-100 的幸运数字,数字落点
// 直接决定奖励档位。前端的五片四叶草只是揭晓动画,选哪张牌都不改变结果 —— 随机
// 权威只在服务端,与小游戏「分数由服务端回放算出」是同一条防线。
//
// 奖励结构由 DrawTier 表达,按 roll 区间从低到高铺满 1-100:
//   - 大多数区间是纯趣味数字(quota=0),表达「多数时候空手」;
//   - 高区间中奖发限时额度(次日 00:00 失效,不进永久余额);
//   - 顶区间发永久额度,额外受「全站每日名额」限制,名额满则降级为限时额度。

// DrawTier 是一档抽奖结果。命中条件是 roll ∈ [RollMin, RollMax](闭区间,1-100)。
// 金额在 [MinQuota, MaxQuota] 间随机(整数口径);两者相等即固定金额,同为 0 即无额度。
type DrawTier struct {
	Label      string `json:"label"`       // 档位名,如「欧皇附体」,随抽奖记录快照持久化
	Quip       string `json:"quip"`        // 揭晓文案,前端据此出这句话
	RollMin    int    `json:"roll_min"`    // 命中区间下界(含),1-100
	RollMax    int    `json:"roll_max"`    // 命中区间上界(含),1-100
	RewardType string `json:"reward_type"` // permanent | temporary;无额度档该字段无意义
	MinQuota   int64  `json:"min_quota"`   // 发放额度下界(整数),0 = 无额度档
	MaxQuota   int64  `json:"max_quota"`   // 发放额度上界(整数),>= MinQuota
	// DailyWinnerLimit 只对**永久额度**档生效:全站每日至多几人拿到该档永久额度,
	// 名额满后命中该档仍给同样金额,但额度类型降级为限时(reason=jackpot_fallback)。
	// 0 = 不限名额。这是一道**软限制**(事务内计数,不加全局锁):真正防超发的硬闸
	// 是 BudgetScopeDraw / BudgetScopeTotal 两个预算池的原子扣减。
	DailyWinnerLimit int `json:"daily_winner_limit"`
}

// DrawConfig 是抽奖注册表(存 w_settings.draw_config)。
// 预算走 BudgetScopeDraw 池,上限在 game_config.budgets 里配,与小游戏共用同一套
// 预算基础设施,不另造一份。
type DrawConfig struct {
	Enabled  bool       `json:"enabled"`
	Timezone string     `json:"timezone"` // 跨日重置基准,默认 Asia/Shanghai
	Tiers    []DrawTier `json:"tiers"`    // 保存时按 roll_min 升序归一化,且必须无缝铺满 1-100
}

const DrawConfigKey = "draw_config"

// drawQuotaUnit 仅用于默认值的可读书写($1 = 500000,与 QUOTA_PER_UNIT 默认值对齐)。
// 运行时的美元换算一律由前端拿 site/info 的 quota_per_unit 做,后端只认整数额度。
const drawQuotaUnit = 500000

// DefaultDrawConfig 是「大奖低频」方案:
//
//	 1 – 90   (90%)  纯趣味数字 · 无额度
//	91 – 98   ( 8%)  中奖 · 限时 $3~$8
//	99 – 100  ( 2%)  大奖 · 永久 $20~$40(全站每日 3 名,名额满降级为限时)
//
// maxGrantQuota 传 cfg.MaxGrantQuota:大奖金额按它**夹住**上限。这不是可选的精细化,
// 而是为了让开箱默认值本身能通过 SaveDrawConfig —— 否则站长进后台什么都不改点一下
// 保存就会被「超过单次发放上限」拒掉,配置页从第一天起就是坏的。
// 想要完整的 $20~$40 大奖,把 MAX_GRANT_QUOTA 调到 >= 20000000 即可。
func DefaultDrawConfig(maxGrantQuota int64) *DrawConfig {
	clamp := func(v int64) int64 {
		if maxGrantQuota > 0 && v > maxGrantQuota {
			return maxGrantQuota
		}
		return v
	}
	return &DrawConfig{
		Enabled:  true,
		Timezone: defaultGameTimezone,
		Tiers: []DrawTier{
			{
				Label:      "一般般绿",
				Quip:       "今天的运气很朴素,不过四叶草已经在替你攒了。",
				RollMin:    1,
				RollMax:    90,
				RewardType: QuotaTypeTemporary,
				MinQuota:   0,
				MaxQuota:   0,
			},
			{
				Label:      "小欧一把",
				Quip:       "叶子给你抖下来一点碎运气,限时额度今日到账,记得用掉。",
				RollMin:    91,
				RollMax:    98,
				RewardType: QuotaTypeTemporary,
				MinQuota:   clamp(3 * drawQuotaUnit),
				MaxQuota:   clamp(8 * drawQuotaUnit),
			},
			{
				Label:            "欧皇附体",
				Quip:             "百里挑一的手气!这是永久额度,稳稳进账。",
				RollMin:          99,
				RollMax:          100,
				RewardType:       QuotaTypePermanent,
				MinQuota:         clamp(20 * drawQuotaUnit),
				MaxQuota:         clamp(40 * drawQuotaUnit),
				DailyWinnerLimit: 3,
			},
		},
	}
}

// GetDrawConfig 读取 draw_config,首次运行落库默认值。
// 缺字段一律零值兜底,不因字段不存在而报错(部署顺序上前端/配置可能旧于后端)。
func GetDrawConfig(db *gorm.DB, maxGrantQuota int64) (*DrawConfig, error) {
	raw, err := GetSetting(db, DrawConfigKey)
	if err != nil {
		return nil, err
	}
	if raw == "" {
		def := DefaultDrawConfig(maxGrantQuota)
		// 默认值是已知合法的(金额已按上限夹过),直接落库,不走校验。
		if err := persistDrawConfig(db, def); err != nil {
			return nil, err
		}
		return def, nil
	}
	var c DrawConfig
	if err := json.Unmarshal([]byte(raw), &c); err != nil {
		return nil, err
	}
	// 时区缺失时回落默认值,否则日界会退化成 UTC,抽奖日期与预算都会错位。
	if c.Timezone == "" {
		c.Timezone = defaultGameTimezone
	}
	for i := range c.Tiers {
		c.Tiers[i].RewardType = NormalizeQuotaType(c.Tiers[i].RewardType)
	}
	// MatchDrawTier 不依赖顺序,但前端要按档位表出「奖励说明」,升序更好读。
	sort.SliceStable(c.Tiers, func(i, j int) bool { return c.Tiers[i].RollMin < c.Tiers[j].RollMin })
	return &c, nil
}

// SaveDrawConfig 校验并持久化 draw_config。
//
// 核心不变式:档位区间必须**无缝铺满** 1-100 且互不重叠 —— 否则某个 roll 落进空档
// 就摇不出结果。这道校验挡的是站长手滑配出「91-98 + 100-100」这种漏了 99 的表:
// 没有它,漏掉的那个数字会变成一次静默失败的抽奖,而且只有 1% 的用户能踩到。
// maxGrantQuota 传 cfg.MaxGrantQuota,挡住手滑配出的天价奖励。
func SaveDrawConfig(db *gorm.DB, c *DrawConfig, maxGrantQuota int64) error {
	if c.Timezone == "" {
		c.Timezone = defaultGameTimezone
	}
	if _, err := time.LoadLocation(c.Timezone); err != nil {
		// 非法时区不报错,回落默认值(与 TodayStr 的容错方向一致)。
		c.Timezone = defaultGameTimezone
	}
	if len(c.Tiers) == 0 {
		return errors.New("抽奖档位不能为空")
	}

	for i := range c.Tiers {
		t := &c.Tiers[i]
		// 空值(旧前端不带该字段)视为永久额度;其他非法取值直接拒绝。
		if t.RewardType == "" {
			t.RewardType = QuotaTypePermanent
		}
		if t.RewardType != QuotaTypePermanent && t.RewardType != QuotaTypeTemporary {
			return fmt.Errorf("档位「%s」的 reward_type 必须是 permanent 或 temporary", t.Label)
		}
		if t.RollMin < 1 || t.RollMax > 100 || t.RollMin > t.RollMax {
			return fmt.Errorf("档位「%s」的幸运数字区间必须落在 1~100 且下界不大于上界", t.Label)
		}
		if t.MinQuota < 0 || t.MaxQuota < t.MinQuota {
			return fmt.Errorf("档位「%s」的额度区间非法(需满足 0 <= 下界 <= 上界)", t.Label)
		}
		if t.MaxQuota > maxGrantQuota {
			return fmt.Errorf("档位「%s」的额度上界 %d 超过单次发放上限 %d", t.Label, t.MaxQuota, maxGrantQuota)
		}
		if t.DailyWinnerLimit < 0 {
			return fmt.Errorf("档位「%s」的每日名额不能为负", t.Label)
		}
	}

	// 归一化:按 roll_min 升序,随后校验无缝铺满 1-100。
	sort.SliceStable(c.Tiers, func(i, j int) bool { return c.Tiers[i].RollMin < c.Tiers[j].RollMin })
	expect := 1
	for _, t := range c.Tiers {
		if t.RollMin != expect {
			return fmt.Errorf("抽奖档位必须无缝覆盖 1~100:期望下一档从 %d 开始,实际从 %d 开始", expect, t.RollMin)
		}
		expect = t.RollMax + 1
	}
	if expect != 101 {
		return fmt.Errorf("抽奖档位必须无缝覆盖 1~100:最后一档应止于 100,实际止于 %d", expect-1)
	}

	return persistDrawConfig(db, c)
}

// persistDrawConfig 序列化并 upsert 配置行。
func persistDrawConfig(db *gorm.DB, c *DrawConfig) error {
	b, err := json.Marshal(c)
	if err != nil {
		return err
	}
	return SetSetting(db, DrawConfigKey, string(b))
}

// MatchDrawTier 返回 roll(1-100)命中的档位。区间在保存时已校验为无缝铺满,
// 正常配置下必然命中;真遇到坏配置(区间有洞)返回 false,由调用方兜底成无奖。
func MatchDrawTier(tiers []DrawTier, roll int) (DrawTier, bool) {
	for _, t := range tiers {
		if roll >= t.RollMin && roll <= t.RollMax {
			return t, true
		}
	}
	return DrawTier{}, false
}
