package service

import (
	"errors"
	"fmt"
	"math"
	"math/rand/v2"
	"time"

	"welfare/model"

	"gorm.io/gorm"
)

// ErrAlreadyCheckedIn is returned when the user already checked in today
// (surfaced by the uk_user_date unique constraint).
var ErrAlreadyCheckedIn = errors.New("今日已签到")

// ErrCheckinDisabled is returned when the admin disabled check-in.
var ErrCheckinDisabled = errors.New("签到功能暂未开放")

// ErrTrustLevelTooLow is returned when the user's trust level is below the
// configured global minimum.
var ErrTrustLevelTooLow = errors.New("当前账号信任等级不足,无法签到")

// ErrCheckedInOnNewAPI 表示用户当日已经在 new-api 签到过了,且无法由福利站
// 存量限时翻牌流水完整解释。两边奖励打的是同一个额度桶,此时不能盲目再发。
var ErrCheckedInOnNewAPI = errors.New("你今天已在 new-api 签到过了,明天再来福利站摘叶子")

// ErrCheckinNotOpen 表示当日签到尚未到开放时间,具体时间由调用方按配置拼文案。
var ErrCheckinNotOpen = errors.New("签到尚未开放")

// FormatOpenTime 把「当日零点后分钟数」格式化为 HH:MM。
func FormatOpenTime(minutes int) string {
	if minutes < 0 {
		minutes = 0
	}
	return fmt.Sprintf("%02d:%02d", minutes/60, minutes%60)
}

// CheckinOpened 判断按配置时区的当前时刻是否已到开放时间。0 = 不限制。
func CheckinOpened(cfg *CheckinConfig, now time.Time) bool {
	if cfg.AvailableFromMinutes <= 0 {
		return true
	}
	loc, err := time.LoadLocation(cfg.Timezone)
	if err != nil {
		loc = time.UTC
	}
	local := now.In(loc)
	return local.Hour()*60+local.Minute() >= cfg.AvailableFromMinutes
}

// hasCheckedInToday 查询福利站自身当日是否已有签到记录。
func hasCheckedInToday(db *gorm.DB, userID int64, today string) (bool, error) {
	var count int64
	err := db.Model(&model.Checkin{}).
		Where("user_id = ? AND checkin_date = ?", userID, today).
		Count(&count).Error
	return count > 0, err
}

// hasSuccessfulTemporaryDrawGrantToday 判断今天 new-api 的限时签到桶是否可以由福利站
// 的旧版翻牌记录解释。
//
// 旧版流程允许先翻牌。限时翻牌会在 new-api 的 checkins 表里留下
// checked_in_today=true，随后福利站签到会被跨系统防重拦截。这里不尝试猜测
// new-api 那一行的来源：先确认福利站确实有同日的限时中奖记录，以及一条字段
// 完全匹配的抽奖流水；调用方还会把 new-api 当日累计额度与福利站成功流水总额
// 严格对账，只有完全一致才放行正常签到。
//
// 只接受 success：pending/failed 无法证明远端已经到账，尤其外呼超时时可能出现
// “远端已执行、本地却记 failed”的不确定状态，兼容分支必须保守拒绝。
func hasSuccessfulTemporaryDrawGrantToday(db *gorm.DB, userID, newapiUserID int64, today string) (bool, error) {
	var draw model.Draw
	err := db.Where(
		"user_id = ? AND draw_date = ? AND quota > 0 AND quota_type = ?",
		userID, today, QuotaTypeTemporary,
	).First(&draw).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return false, nil
	}
	if err != nil {
		return false, err
	}

	var grant model.Grant
	err = db.Where(
		"type = ? AND ref_id = ? AND user_id = ? AND newapi_user_id = ? AND quota = ? AND quota_type = ? AND status = ?",
		GrantTypeDraw, draw.ID, userID, newapiUserID, draw.Quota, QuotaTypeTemporary, GrantStatusSuccess,
	).First(&grant).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return true, nil
}

// successfulTemporaryGrantsToday 返回福利站在 new-api 北京时间当天已经确认成功
// 的所有限时额度流水总和。这里只统计 success，故外呼超时后本地 failed/pending
// 的金额不会被猜作已到账，避免兼容分支扩大双发窗口。
func successfulTemporaryGrantsToday(db *gorm.DB, userID, newapiUserID int64, now time.Time) (int64, error) {
	loc, err := time.LoadLocation("Asia/Shanghai")
	if err != nil {
		loc = time.FixedZone("Asia/Shanghai", 8*60*60)
	}
	local := now.In(loc)
	start := time.Date(local.Year(), local.Month(), local.Day(), 0, 0, 0, 0, loc)
	end := start.AddDate(0, 0, 1)

	var total int64
	err = db.Model(&model.Grant{}).
		Where(
			"user_id = ? AND newapi_user_id = ? AND quota_type = ? AND status = ? AND updated_at >= ? AND updated_at < ?",
			userID, newapiUserID, QuotaTypeTemporary, GrantStatusSuccess, start, end,
		).
		Select("COALESCE(SUM(quota), 0)").
		Scan(&total).Error
	return total, err
}

// TodayStr returns today's "YYYY-MM-DD" in the configured timezone.
func TodayStr(timezone string, now time.Time) string {
	loc, err := time.LoadLocation(timezone)
	if err != nil {
		loc = time.UTC
	}
	return now.In(loc).Format("2006-01-02")
}

// CalcStreak computes the new streak: yesterday checked in → yesterday+1,
// otherwise 1 (design.md §3 / R2.4).
func CalcStreak(db *gorm.DB, userID int64, now time.Time, timezone string) (int, error) {
	loc, err := time.LoadLocation(timezone)
	if err != nil {
		loc = time.UTC
	}
	yesterdayStr := now.In(loc).AddDate(0, 0, -1).Format("2006-01-02")

	var prev model.Checkin
	err = db.Where("user_id = ? AND checkin_date = ?", userID, yesterdayStr).First(&prev).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return 1, nil
	}
	if err != nil {
		return 0, err
	}
	return prev.Streak + 1, nil
}

// ComputeReward returns (base, bonusRate, total, error) per design.md §3:
// base = fixed or rand[min,max]; bonus = highest tier with days <= streak;
// total = round(base * (1 + bonus)).
func ComputeReward(cfg *CheckinConfig, streak int) (int64, float64, int64, error) {
	var base int64
	switch cfg.Mode {
	case "fixed":
		base = cfg.FixedQuota
	case "random":
		lo, hi := cfg.MinQuota, cfg.MaxQuota
		if hi <= lo {
			hi = lo + 1
		}
		base = lo + rand.Int64N(hi-lo+1)
	default:
		return 0, 0, 0, errors.New("invalid checkin mode")
	}
	bonus := 0.0
	for _, t := range cfg.StreakBonuses {
		if streak >= t.Days && t.Bonus > bonus {
			bonus = t.Bonus
		}
	}
	total := int64(math.Round(float64(base) * (1 + bonus)))
	return base, bonus, total, nil
}

// CheckinResult is returned to controllers.
type CheckinResult struct {
	Checkin *model.Checkin
	Grant   *model.Grant
	Base    int64
	Bonus   float64
	// Reconciled 表示旧版先翻牌后签到的存量记录已对账。
	// 为 true 时仍会正常创建签到与发放流水；该字段供控制器选择更准确的提示文案。
	Reconciled bool
	// OutErr is the new-api call error; nil means the quota landed.
	OutErr error
}

// DoCheckin performs the full check-in flow (design.md §8 + R2):
//  1. compute today in the configured timezone
//  2. compute streak from yesterday
//  3. compute reward (存量对账仍正常发放福利站签到奖励)
//  4. inside one transaction: insert w_checkins (unique uk_user_date) +
//     pending w_grants(type=checkin)
//  5. commit, then execute the payout
func DoCheckin(db *gorm.DB, grants *GrantService, cfg *CheckinConfig, user *model.User) (*CheckinResult, error) {
	if !cfg.Enabled {
		return nil, ErrCheckinDisabled
	}
	now := time.Now()
	today := TodayStr(cfg.Timezone, now)
	if !CheckinOpened(cfg, now) {
		return nil, ErrCheckinNotOpen
	}
	if user.TrustLevel < cfg.MinTrustLevel {
		return nil, ErrTrustLevelTooLow
	}
	if user.NewapiUserID == nil {
		return nil, errors.New("请先绑定 new-api 账号")
	}

	// 跨系统防重复签到。顺序很重要:必须先确认福利站自己当日没签过,再问 new-api。
	// 限时额度模式下福利站自己的发放同样会在 new-api 留下当日签到记录,顺序颠倒
	// 会把自己发的那笔误判成 new-api 内置签到。
	already, err := hasCheckedInToday(db, user.ID, today)
	if err != nil {
		return nil, err
	}
	if already {
		return nil, ErrAlreadyCheckedIn
	}
	reconciled := false
	if grants.newapi != nil {
		// 探测失败(new-api 不可达/旧版无此字段)一律放行:此时发放本身也会失败并进
		// 入可重试流水,不因为探测不到就把用户挡在门外。
		if u, err := grants.newapi.GetUser(*user.NewapiUserID); err == nil && u != nil && u.CheckedInToday {
			// 兼容旧版先翻牌后签到，但必须同时满足：new-api 明确是限时桶、
			// 返回的当日累计额度>0、本地存在同日完整翻牌链路，且 new-api
			// 的累计额度与福利站当天已确认成功的所有限时流水严格相等。
			// 这样普通内置签到（或本地 failed/pending 尚未确认的外呼）都不会
			// 被误放行；通过后仍会正常发放本次福利站签到奖励。
			if u.TodayCheckinQuotaType == QuotaTypeTemporary && u.TodayCheckinQuotaAwarded > 0 {
				reconciled, err = hasSuccessfulTemporaryDrawGrantToday(db, user.ID, *user.NewapiUserID, today)
				if err != nil {
					return nil, err
				}
				if reconciled {
					var localTotal int64
					localTotal, err = successfulTemporaryGrantsToday(db, user.ID, *user.NewapiUserID, now)
					if err != nil {
						return nil, err
					}
					reconciled = localTotal == u.TodayCheckinQuotaAwarded
				}
			}
			if !reconciled {
				return nil, ErrCheckedInOnNewAPI
			}
		}
	}

	streak, err := CalcStreak(db, user.ID, now, cfg.Timezone)
	if err != nil {
		return nil, err
	}
	base, bonus, total, err := ComputeReward(cfg, streak)
	if err != nil {
		return nil, err
	}

	var checkin model.Checkin
	var grant model.Grant
	err = db.Transaction(func(tx *gorm.DB) error {
		checkin = model.Checkin{UserID: user.ID, CheckinDate: today, Quota: total, Streak: streak}
		if err := tx.Create(&checkin).Error; err != nil {
			if isDuplicateErr(err) {
				return ErrAlreadyCheckedIn
			}
			return err
		}
		grant = model.Grant{
			UserID:       user.ID,
			NewapiUserID: *user.NewapiUserID,
			Type:         "checkin",
			RefID:        checkin.ID,
			Quota:        total,
			QuotaType:    NormalizeQuotaType(cfg.RewardType),
		}
		return grants.GrantTx(tx, &grant)
	})
	if err != nil {
		return nil, err
	}

	outErr := grants.ExecuteAfterCommit(&grant)
	return &CheckinResult{
		Checkin: &checkin, Grant: &grant, Base: base, Bonus: bonus,
		Reconciled: reconciled, OutErr: outErr,
	}, nil
}

// GetCheckinView returns the user's check-in summary for GET /api/checkin:
// today's status, current streak, calendar for the current month, and the
// active rules summary.
func GetCheckinView(db *gorm.DB, cfg *CheckinConfig, user *model.User, now time.Time) (map[string]any, error) {
	today := TodayStr(cfg.Timezone, now)
	loc, err := time.LoadLocation(cfg.Timezone)
	if err != nil {
		loc = time.UTC
	}

	var latest model.Checkin
	_ = db.Where("user_id = ?", user.ID).Order("checkin_date desc").First(&latest).Error

	// Calendar for the current (configured-timezone) month.
	nowLocal := now.In(loc)
	monthStart := time.Date(nowLocal.Year(), nowLocal.Month(), 1, 0, 0, 0, 0, loc)
	nextMonth := monthStart.AddDate(0, 1, 0)
	monthEnd := nextMonth.AddDate(0, 0, -1)

	var monthCheckins []model.Checkin
	err = db.
		Where("user_id = ? AND checkin_date >= ? AND checkin_date <= ?", user.ID,
			monthStart.Format("2006-01-02"), monthEnd.Format("2006-01-02")).
		Order("checkin_date asc").
		Find(&monthCheckins).Error
	if err != nil {
		return nil, err
	}

	dates := make([]string, 0, len(monthCheckins))
	checkedToday := false
	for _, c := range monthCheckins {
		dates = append(dates, c.CheckinDate)
		if c.CheckinDate == today {
			checkedToday = true
		}
	}

	// Current streak = latest streak, but 0 if the latest checkin isn't today
	// or yesterday (streak would have reset).
	streak := 0
	if len(monthCheckins) > 0 {
		streak = latest.Streak
		if latest.CheckinDate != today && latest.CheckinDate != now.In(loc).AddDate(0, 0, -1).Format("2006-01-02") {
			streak = 0
		}
	}

	return map[string]any{
		"today":         today,
		"checked_today": checkedToday,
		"streak":        streak,
		"calendar":      dates,
		"opened":        CheckinOpened(cfg, now),
		"rules": map[string]any{
			"enabled":                cfg.Enabled,
			"mode":                   cfg.Mode,
			"reward_type":            NormalizeQuotaType(cfg.RewardType),
			"fixed_quota":            cfg.FixedQuota,
			"min_quota":              cfg.MinQuota,
			"max_quota":              cfg.MaxQuota,
			"streak_bonuses":         cfg.StreakBonuses,
			"timezone":               cfg.Timezone,
			"available_from_minutes": cfg.AvailableFromMinutes,
			"available_from":         FormatOpenTime(cfg.AvailableFromMinutes),
		},
	}, nil
}
