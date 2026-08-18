package service

import (
	"errors"
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
	// OutErr is the new-api call error; nil means the quota landed.
	OutErr error
}

// DoCheckin performs the full check-in flow (design.md §8 + R2):
//  1. compute today in the configured timezone
//  2. compute streak from yesterday
//  3. compute reward
//  4. inside one transaction: insert w_checkins (unique uk_user_date) +
//     pending w_grants(type=checkin)
//  5. commit, then execute the payout
func DoCheckin(db *gorm.DB, grants *GrantService, cfg *CheckinConfig, user *model.User) (*CheckinResult, error) {
	if !cfg.Enabled {
		return nil, ErrCheckinDisabled
	}
	now := time.Now()
	today := TodayStr(cfg.Timezone, now)
	if user.TrustLevel < cfg.MinTrustLevel {
		return nil, ErrTrustLevelTooLow
	}
	if user.NewapiUserID == nil {
		return nil, errors.New("请先绑定 new-api 账号")
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
		}
		return grants.GrantTx(tx, &grant)
	})
	if err != nil {
		return nil, err
	}

	outErr := grants.ExecuteAfterCommit(&grant)
	return &CheckinResult{Checkin: &checkin, Grant: &grant, Base: base, Bonus: bonus, OutErr: outErr}, nil
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
		"rules": map[string]any{
			"enabled":        cfg.Enabled,
			"mode":           cfg.Mode,
			"fixed_quota":    cfg.FixedQuota,
			"min_quota":      cfg.MinQuota,
			"max_quota":      cfg.MaxQuota,
			"streak_bonuses": cfg.StreakBonuses,
			"timezone":       cfg.Timezone,
		},
	}, nil
}
