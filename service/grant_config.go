package service

import (
	"encoding/json"
	"fmt"

	"gorm.io/gorm"
)

// ---- 全局发放限制(grant_config)----
//
// MaxGrantQuota 是**单次发放**的额度上限,同时约束三处:手动发放、小游戏奖励档位、
// 抽奖奖励档位。它原先只是 MAX_GRANT_QUOTA 环境变量,改动要重启;搬进配置表后站长
// 可以在后台直接调,环境变量退化为**首次运行的种子值**。
//
// 为什么可以交给后台:后台本来就能改每档奖励金额与每日预算池,能改这些的人早就
// 能发出大额额度了。这个上限挡的是**打字手滑**(多打一个零),不是权限边界,
// 因此没有理由把它锁在环境变量里、逼站长为了调一个数字去重启服务。

// grantConfigAbsoluteMax 是后台可填的绝对天花板,纯粹作为手滑护栏:
// 按默认 QUOTA_PER_UNIT=500000 折算约 $20000。不是权限边界,只是让「多打三个零」
// 这类输入在保存时就被拦住,而不是变成一笔真的发出去的天价额度。
const grantConfigAbsoluteMax int64 = 10_000_000_000

// GrantConfig 是与具体玩法无关的发放限制。
type GrantConfig struct {
	// MaxGrantQuota 单次发放额度上限(整数口径),必须 > 0。
	MaxGrantQuota int64 `json:"max_grant_quota"`
}

const GrantConfigKey = "grant_config"

// GetGrantConfig 读取 grant_config,首次运行用 envDefault(即 cfg.MaxGrantQuota)播种。
//
// 播种而非硬编码默认值,是为了让**存量部署平滑升级**:站长此前在环境变量里配的值
// 会成为落库的初始值,升级前后行为一致;之后再改就走后台,环境变量不再生效。
func GetGrantConfig(db *gorm.DB, envDefault int64) (*GrantConfig, error) {
	raw, err := GetSetting(db, GrantConfigKey)
	if err != nil {
		return nil, err
	}
	if raw == "" {
		if envDefault <= 0 {
			envDefault = 25_000_000 // 兜底 $50(按默认换算系数),与 config 默认值一致
		}
		def := &GrantConfig{MaxGrantQuota: envDefault}
		if err := persistGrantConfig(db, def); err != nil {
			return nil, err
		}
		return def, nil
	}
	var c GrantConfig
	if err := json.Unmarshal([]byte(raw), &c); err != nil {
		return nil, err
	}
	// 存量/坏数据兜底:0 或负数会让所有发放校验直接失败,回落到环境变量值。
	if c.MaxGrantQuota <= 0 {
		c.MaxGrantQuota = envDefault
	}
	return &c, nil
}

// SaveGrantConfig 校验并持久化 grant_config。
func SaveGrantConfig(db *gorm.DB, c *GrantConfig) error {
	if c.MaxGrantQuota <= 0 {
		return fmt.Errorf("单次发放上限必须大于 0")
	}
	if c.MaxGrantQuota > grantConfigAbsoluteMax {
		return fmt.Errorf("单次发放上限 %d 过大(上界 %d),请确认没有多打零",
			c.MaxGrantQuota, grantConfigAbsoluteMax)
	}
	return persistGrantConfig(db, c)
}

// persistGrantConfig 序列化并 upsert 配置行。
func persistGrantConfig(db *gorm.DB, c *GrantConfig) error {
	b, err := json.Marshal(c)
	if err != nil {
		return err
	}
	return SetSetting(db, GrantConfigKey, string(b))
}

// MaxGrantQuotaOf 是给调用方的便捷读法:读不出配置时回落 envDefault,
// 绝不返回 0 —— 返回 0 会让「quota <= max」这类校验把一切发放都拒掉。
func MaxGrantQuotaOf(db *gorm.DB, envDefault int64) int64 {
	cfg, err := GetGrantConfig(db, envDefault)
	if err != nil || cfg.MaxGrantQuota <= 0 {
		return envDefault
	}
	return cfg.MaxGrantQuota
}
