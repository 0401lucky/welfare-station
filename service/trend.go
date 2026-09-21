package service

import (
	"time"

	"welfare/model"

	"gorm.io/gorm"
)

// maxTrendDays 限制趋势图一次最多回看多少天。
const maxTrendDays = 30

// TrendDay 是某一天的参与与到账汇总。
type TrendDay struct {
	Date     string `json:"date"`
	Checkins int64  `json:"checkins"` // 签到人数(一人一天一条)
	Draws    int64  `json:"draws"`    // 抽奖人数(一人一天一次)
	Plays    int64  `json:"plays"`    // 游戏局数
	Quota    int64  `json:"quota"`    // 成功发放额度(整数口径)
}

// dateCount 承接「按日期分组计数」的查询结果。
type dateCount struct {
	Name  string
	Total int64
}

// DashboardTrend 返回近 days 天(含今日)的四条序列,按日期升序,最后一项是今日。
//
// 签到 / 抽奖 / 对局三张表都有按配置时区落好的 date 列,各一次 GROUP BY;发放流水
// 只有 created_at 时间戳,一次取出窗口内的成功流水在 Go 里按 timezone 分桶,
// 避免在 SQL 里写方言相关的时区转换(SQLite 与 MySQL 不一样)。
func DashboardTrend(db *gorm.DB, timezone string, days int, now time.Time) ([]TrendDay, error) {
	if days < 1 {
		days = 1
	}
	if days > maxTrendDays {
		days = maxTrendDays
	}
	loc := LoadLocationOr(timezone)

	dates := make([]string, 0, days)
	index := make(map[string]int, days)
	out := make([]TrendDay, days)
	for i := days - 1; i >= 0; i-- {
		d := TodayStr(timezone, now.AddDate(0, 0, -i))
		index[d] = len(dates)
		out[len(dates)] = TrendDay{Date: d}
		dates = append(dates, d)
	}

	fill := func(table, dateCol string, set func(day *TrendDay, n int64)) error {
		var rows []dateCount
		err := db.Table(table).
			Select(dateCol+" as name, COUNT(*) as total").
			Where(dateCol+" IN ?", dates).
			Group(dateCol).
			Scan(&rows).Error
		if err != nil {
			return err
		}
		for _, r := range rows {
			if i, ok := index[r.Name]; ok {
				set(&out[i], r.Total)
			}
		}
		return nil
	}
	if err := fill(model.Checkin{}.TableName(), "checkin_date", func(d *TrendDay, n int64) { d.Checkins = n }); err != nil {
		return nil, err
	}
	if err := fill(model.Draw{}.TableName(), "draw_date", func(d *TrendDay, n int64) { d.Draws = n }); err != nil {
		return nil, err
	}
	if err := fill(model.GamePlay{}.TableName(), "play_date", func(d *TrendDay, n int64) { d.Plays = n }); err != nil {
		return nil, err
	}

	// 发放额度:窗口 = 首日零点(配置时区)到明日零点。
	local := now.In(loc)
	end := time.Date(local.Year(), local.Month(), local.Day(), 0, 0, 0, 0, loc).AddDate(0, 0, 1)
	start := end.AddDate(0, 0, -days)
	var grants []struct {
		CreatedAt time.Time
		Quota     int64
	}
	err := db.Model(&model.Grant{}).
		Select("created_at, quota").
		Where("status = ? AND created_at >= ? AND created_at < ?", GrantStatusSuccess, start, end).
		Scan(&grants).Error
	if err != nil {
		return nil, err
	}
	for _, g := range grants {
		if i, ok := index[TodayStr(timezone, g.CreatedAt)]; ok {
			out[i].Quota += g.Quota
		}
	}
	return out, nil
}

// CurrentStreak 返回用户当前连签天数:最近一次签到在今天或昨天则取其 streak,
// 否则连签已断,记 0。与 GetCheckinView 给前台的口径一致。
func CurrentStreak(db *gorm.DB, userID int64, timezone string, now time.Time) (int, error) {
	var latest model.Checkin
	err := db.Where("user_id = ?", userID).Order("checkin_date desc").First(&latest).Error
	if err != nil {
		if err == gorm.ErrRecordNotFound {
			return 0, nil
		}
		return 0, err
	}
	today := TodayStr(timezone, now)
	yesterday := TodayStr(timezone, now.AddDate(0, 0, -1))
	if latest.CheckinDate != today && latest.CheckinDate != yesterday {
		return 0, nil
	}
	return latest.Streak, nil
}
