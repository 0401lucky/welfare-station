package service

import (
	"crypto/rand"
	"errors"
	"math/big"
	"net/url"
	"strings"
	"time"

	"welfare/model"

	"gorm.io/gorm"
)

const MaxActivityInteger int64 = 9007199254740991

var ErrPacketSequence = errors.New("领取序号已变化，请刷新后重试")
var ErrPacketParticipant = errors.New("领取后才可查看红包明细")
var ErrActivityRulesLocked = errors.New("已有领取记录，红包金额规则及领取方式不可修改")

func NormalizeActivity(a *model.Activity) {
	if a.ClaimMode == "" {
		a.ClaimMode = "direct"
	}
	if a.PacketMode == "" {
		a.PacketMode = "fixed"
	}
	a.RulesLocked = a.ClaimedCount > 0
}

func ValidateActivity(a *model.Activity, quotaPerUnit int64) error {
	NormalizeActivity(a)
	if a.ClaimMode != "direct" && a.ClaimMode != "red_packet" {
		return errors.New("无效的领取方式")
	}
	if a.PacketMode != "fixed" && a.PacketMode != "random" {
		return errors.New("无效的红包模式")
	}
	if strings.TrimSpace(a.Title) == "" || a.TotalCount <= 0 || int64(a.TotalCount) > MaxActivityInteger {
		return errors.New("标题和正整数份数必填")
	}
	if a.PerUserLimit <= 0 {
		a.PerUserLimit = 1
	}
	if int64(a.PerUserLimit) > MaxActivityInteger {
		return errors.New("领取次数过大")
	}
	if a.MinTrustLevel < 0 {
		a.MinTrustLevel = 0
	}
	if a.EndAt.Before(a.StartAt) {
		return errors.New("结束时间需晚于开始时间")
	}
	if !ValidActivityCover(a.CoverURL) {
		return errors.New("封面需为站内绝对路径或 HTTPS 图片地址")
	}
	if a.ClaimMode == "red_packet" && a.PacketMode == "random" {
		if a.MinQuota == 0 {
			a.MinQuota = quotaPerUnit / 100
			if a.MinQuota < 1 {
				a.MinQuota = 1
			}
		}
		if a.MinQuota <= 0 || a.MinQuota > MaxActivityInteger/int64(a.TotalCount) || a.TotalQuota > MaxActivityInteger || a.TotalQuota < a.MinQuota*int64(a.TotalCount) {
			return errors.New("红包总额不足或金额超出安全范围")
		}
		a.Quota = 0
	} else {
		if a.Quota <= 0 || a.Quota > MaxActivityInteger/int64(a.TotalCount) {
			return errors.New("额度需为正整数且总额不可超出安全范围")
		}
		if a.ClaimMode == "red_packet" {
			a.TotalQuota = a.Quota * int64(a.TotalCount)
		} else {
			a.TotalQuota = 0
		}
		a.MinQuota = 0
	}
	return nil
}

func ValidActivityCover(raw string) bool {
	if raw == "" {
		return true
	}
	if len(raw) > 2048 || strings.ContainsAny(raw, "\\\r\n\t") {
		return false
	}
	u, err := url.Parse(raw)
	if err != nil {
		return false
	}
	return (strings.HasPrefix(raw, "/") && !strings.HasPrefix(raw, "//") && u.Host == "") || (u.Scheme == "https" && u.Host != "" && u.User == nil)
}

// WithActivityLock acquires a write lock BEFORE reading, including on SQLite.
// Retrying only the local transaction never re-executes a network payout.
func WithActivityLock(db *gorm.DB, id int64, fn func(*gorm.DB, *model.Activity) error) error {
	var err error
	for attempt := 0; attempt < 8; attempt++ {
		err = db.Transaction(func(tx *gorm.DB) error {
			if e := tx.Model(&model.Activity{}).Where("id = ?", id).UpdateColumn("claimed_count", gorm.Expr("claimed_count")).Error; e != nil {
				return e
			}
			var a model.Activity
			if e := tx.First(&a, id).Error; e != nil {
				return e
			}
			NormalizeActivity(&a)
			return fn(tx, &a)
		})
		if err == nil {
			return nil
		}
		message := strings.ToLower(err.Error())
		if !strings.Contains(message, "database is locked") && !strings.Contains(message, "database table is locked") && !strings.Contains(message, "sqlite_busy") && !strings.Contains(message, "deadlock") && !strings.Contains(message, "lock wait timeout") {
			return err
		}
		time.Sleep(time.Duration(attempt+1) * 5 * time.Millisecond)
	}
	return err
}

func UpdateActivity(db *gorm.DB, id int64, desired model.Activity) (before, after model.Activity, err error) {
	err = WithActivityLock(db, id, func(tx *gorm.DB, current *model.Activity) error {
		before = *current
		if desired.TotalCount < current.ClaimedCount {
			return errors.New("总份数不能小于已领取份数")
		}
		if current.ClaimedCount > 0 {
			if desired.ClaimMode != current.ClaimMode {
				return ErrActivityRulesLocked
			}
			if current.ClaimMode == "red_packet" && (desired.PacketMode != current.PacketMode || desired.Quota != current.Quota || desired.TotalQuota != current.TotalQuota || desired.MinQuota != current.MinQuota || desired.TotalCount != current.TotalCount) {
				return ErrActivityRulesLocked
			}
		}
		if e := tx.Model(current).Select("title", "description", "quota", "total_count", "per_user_limit", "min_trust_level", "start_at", "end_at", "status", "claim_mode", "packet_mode", "total_quota", "min_quota", "cover_url").Updates(desired).Error; e != nil {
			return e
		}
		after = *current
		NormalizeActivity(&after)
		return nil
	})
	return
}

func packetAmount(remaining int64, copies int, minimum int64) (int64, error) {
	if copies <= 0 || minimum <= 0 || remaining > MaxActivityInteger || minimum > remaining/int64(copies) {
		return 0, errors.New("红包余额数据异常")
	}
	if copies == 1 {
		return remaining, nil
	}
	upper := 2 * remaining / int64(copies) // remaining <= 2^53-1, doubling fits int64
	if upper < minimum {
		upper = minimum
	}
	reservedUpper := remaining - int64(copies-1)*minimum
	if upper > reservedUpper {
		upper = reservedUpper
	}
	n, err := rand.Int(rand.Reader, big.NewInt(upper-minimum+1))
	if err != nil {
		return 0, err
	}
	return minimum + n.Int64(), nil
}
