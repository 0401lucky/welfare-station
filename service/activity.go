package service

import (
	"errors"
	"time"

	"welfare/model"

	"gorm.io/gorm"
)

// Activity statuses (w_activities.status).
const (
	ActivityStatusOn  = 1
	ActivityStatusOff = 2
)

// Claim-availability states exposed to the frontend.
const (
	ClaimAvailable  = "available"
	ClaimSoldOut    = "sold_out"
	ClaimNotStarted = "not_started"
	ClaimEnded      = "ended"
	ClaimLoginOnly  = "login_required" // 未登录可见,登录后领取
)

// ErrActivitySoldOut, ErrActivityNotStarted, ErrActivityEnded, ErrClaimLimit,
// ErrTrustLevelLow are claim rejection reasons surfaced to the UI.
var (
	ErrActivityNotFound = errors.New("活动不存在或已下架")
	ErrActivitySoldOut  = errors.New("手慢了,已被领完")
	ErrActivityNotStart = errors.New("活动尚未开始")
	ErrActivityEnded    = errors.New("活动已结束")
	ErrClaimLimit       = errors.New("已达领取上限")
	ErrTrustLevelLow    = errors.New("信任等级不足,无法领取")
	ErrNotBound         = errors.New("请先绑定 new-api 账号")
)

// PublicActivity is the shape returned by GET /api/activities (no internal
// knobs like claimed_count raw pointer).
type PublicActivity struct {
	model.Activity
	Status                string  `json:"status"`    // claim availability
	Remaining             int     `json:"remaining"` // remaining copies
	Claimed               int     `json:"claimed"`   // claimed copies
	Progress              float64 `json:"progress"`  // 0..1 used ratio
	StartAtUnix           int64   `json:"start_at_unix"`
	EndAtUnix             int64   `json:"end_at_unix"`
	UserClaimCount        int     `json:"user_claim_count"`         // 当前用户已领取次数
	UserClaimLimitReached bool    `json:"user_claim_limit_reached"` // 当前用户是否达到个人上限
}

// ActivityClaimAvailability computes the per-viewer claim state.
func ActivityClaimAvailability(a *model.Activity, now time.Time) string {
	switch {
	case a.Status != ActivityStatusOn:
		return ClaimLoginOnly
	case now.Before(a.StartAt):
		return ClaimNotStarted
	case now.After(a.EndAt):
		return ClaimEnded
	case a.ClaimedCount >= a.TotalCount:
		return ClaimSoldOut
	default:
		return ClaimAvailable
	}
}

// ListPublicActivities returns the on-shelf activities with availability state.
// viewer 为空时按匿名访问处理，保持公开接口无需认证。
func ListPublicActivities(db *gorm.DB, now time.Time, viewer *model.User) ([]PublicActivity, error) {
	var acts []model.Activity
	err := db.Where("status = ?", ActivityStatusOn).Order("start_at asc").Find(&acts).Error
	if err != nil {
		return nil, err
	}

	userClaimCounts := make(map[int64]int64)
	if viewer != nil && len(acts) > 0 {
		activityIDs := make([]int64, 0, len(acts))
		for i := range acts {
			activityIDs = append(activityIDs, acts[i].ID)
		}
		var rows []struct {
			ActivityID int64 `gorm:"column:activity_id"`
			Count      int64 `gorm:"column:claim_count"`
		}
		if err := db.Model(&model.Claim{}).
			Select("activity_id, COUNT(*) AS claim_count").
			Where("user_id = ? AND activity_id IN ?", viewer.ID, activityIDs).
			Group("activity_id").
			Scan(&rows).Error; err != nil {
			return nil, err
		}
		for _, row := range rows {
			userClaimCounts[row.ActivityID] = row.Count
		}
	}

	out := make([]PublicActivity, 0, len(acts))
	for i := range acts {
		a := &acts[i]
		avail := ActivityClaimAvailability(a, now)
		remaining := a.TotalCount - a.ClaimedCount
		if remaining < 0 {
			remaining = 0
		}
		progress := 0.0
		if a.TotalCount > 0 {
			progress = float64(a.ClaimedCount) / float64(a.TotalCount)
		}
		userClaimCount := int(userClaimCounts[a.ID])
		out = append(out, PublicActivity{
			Activity:              *a,
			Status:                avail,
			Remaining:             remaining,
			Claimed:               a.ClaimedCount,
			Progress:              progress,
			StartAtUnix:           a.StartAt.Unix(),
			EndAtUnix:             a.EndAt.Unix(),
			UserClaimCount:        userClaimCount,
			UserClaimLimitReached: userClaimCount >= a.PerUserLimit,
		})
	}
	return out, nil
}

// CanClaim runs the shared, order-sensitive validation chain (R3.2):
// bind → welfare status → new-api status → time window → trust level →
// per-user limit. It returns the next seq for this user.
func CanClaim(db *gorm.DB, a *model.Activity, user *model.User, newapiStatusOK bool, now time.Time) (nextSeq int, err error) {
	if a.Status != ActivityStatusOn {
		return 0, ErrActivityNotFound
	}
	if user.NewapiUserID == nil {
		return 0, ErrNotBound
	}
	if user.Status != 1 {
		return 0, errors.New("账号已被禁用")
	}
	if !newapiStatusOK {
		return 0, errors.New("new-api 账号状态异常")
	}
	if now.Before(a.StartAt) {
		return 0, ErrActivityNotStart
	}
	if now.After(a.EndAt) {
		return 0, ErrActivityEnded
	}
	if user.TrustLevel < a.MinTrustLevel {
		return 0, ErrTrustLevelLow
	}

	var cnt int64
	if err := db.Model(&model.Claim{}).
		Where("activity_id = ? AND user_id = ?", a.ID, user.ID).
		Count(&cnt).Error; err != nil {
		return 0, err
	}
	nextSeq = int(cnt) + 1
	if nextSeq > a.PerUserLimit {
		return 0, ErrClaimLimit
	}
	return nextSeq, nil
}

// ClaimResult is returned by DoClaim.
type ClaimResult struct {
	Claim  *model.Claim
	Grant  *model.Grant
	OutErr error
}

// DoClaim runs the full claim flow (R3.2 / R3.3):
//  1. verify the new-api account is active (status == 1)
//  2. business+grant insert inside one transaction, with the atomic stock
//     decrement `UPDATE ... claimed_count+1 WHERE claimed_count < total_count`
//  3. commit, then execute the payout.
func DoClaim(db *gorm.DB, grants *GrantService, newapi *NewAPIClient, user *model.User, activityID int64, now time.Time) (*ClaimResult, error) {
	// Fetch activity inside the tx too, to read fresh state at claim time.
	var a model.Activity
	if err := db.First(&a, activityID).Error; err != nil {
		return nil, ErrActivityNotFound
	}

	newapiStatusOK := true
	if user.NewapiUserID != nil {
		nu, err := newapi.GetUser(*user.NewapiUserID)
		if err != nil {
			return nil, errors.New("new-api 账号状态校验失败,请稍后再试")
		}
		newapiStatusOK = nu.Status == 1
	}
	nextSeq, err := CanClaim(db, &a, user, newapiStatusOK, now)
	if err != nil {
		return nil, err
	}

	var claim model.Claim
	var grant model.Grant
	err = db.Transaction(func(tx *gorm.DB) error {
		// Atomic stock decrement (design.md §8.5): 0 rows → sold out.
		res := tx.Model(&model.Activity{}).
			Where("id = ? AND claimed_count < total_count", a.ID).
			Update("claimed_count", gorm.Expr("claimed_count + 1"))
		if res.Error != nil {
			return res.Error
		}
		if res.RowsAffected == 0 {
			return ErrActivitySoldOut
		}

		claim = model.Claim{ActivityID: a.ID, UserID: user.ID, Quota: a.Quota, Seq: nextSeq}
		if err := tx.Create(&claim).Error; err != nil {
			if isDuplicateErr(err) {
				return ErrClaimLimit
			}
			return err
		}
		grant = model.Grant{
			UserID:       user.ID,
			NewapiUserID: *user.NewapiUserID,
			Type:         "activity",
			RefID:        claim.ID,
			Quota:        a.Quota,
		}
		return grants.GrantTx(tx, &grant)
	})
	if err != nil {
		return nil, err
	}

	outErr := grants.ExecuteAfterCommit(&grant)
	return &ClaimResult{Claim: &claim, Grant: &grant, OutErr: outErr}, nil
}
