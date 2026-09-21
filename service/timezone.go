package service

import "time"

// DefaultTimezone 是签到/抽奖/游戏配置共用的默认时区,也是所有时区回退的终点。
const DefaultTimezone = "Asia/Shanghai"

// LoadLocationOr 按名字加载时区;名字为空或无法识别时回退到 DefaultTimezone,
// 系统缺 tzdata 时再退到固定 +08:00。任何情况下都不会退到 UTC,避免日界口径
// 在异常环境下悄悄漂移。
func LoadLocationOr(tz string) *time.Location {
	if tz != "" {
		if loc, err := time.LoadLocation(tz); err == nil {
			return loc
		}
	}
	if loc, err := time.LoadLocation(DefaultTimezone); err == nil {
		return loc
	}
	return time.FixedZone(DefaultTimezone, 8*60*60)
}
