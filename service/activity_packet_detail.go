package service

import (
	"errors"
	"strings"
	"time"

	"welfare/model"

	"gorm.io/gorm"
)

type PacketOwnClaim struct {
	ClaimID     int64     `json:"claim_id"`
	Seq         int       `json:"seq"`
	Quota       int64     `json:"quota"`
	CreatedAt   time.Time `json:"created_at"`
	GrantStatus string    `json:"grant_status"`
}
type PacketParticipant struct {
	ClaimID   int64     `json:"claim_id"`
	Nickname  string    `json:"nickname"`
	AvatarURL string    `json:"avatar_url"`
	Quota     int64     `json:"quota"`
	CreatedAt time.Time `json:"created_at"`
	IsBest    bool      `json:"is_best"`
}
type PacketDetail struct {
	Summary   PublicActivity      `json:"summary"`
	OwnClaims []PacketOwnClaim    `json:"own_claims"`
	Items     []PacketParticipant `json:"items"`
	Total     int64               `json:"total"`
	Page      int                 `json:"page"`
	PageSize  int                 `json:"page_size"`
}

func GetPacketDetail(db *gorm.DB, id, userID int64, page, size int, now time.Time) (*PacketDetail, error) {
	if page < 1 {
		page = 1
	}
	if size < 1 {
		size = 20
	}
	if size > 100 {
		size = 100
	}
	if page > 1000000 {
		return nil, errors.New("页码过大")
	}
	out := &PacketDetail{Page: page, PageSize: size, OwnClaims: []PacketOwnClaim{}, Items: []PacketParticipant{}}
	// A single transaction keeps the complete-pool best calculation and summary consistent.
	err := db.Transaction(func(tx *gorm.DB) error {
		var a model.Activity
		if e := tx.First(&a, id).Error; e != nil {
			return e
		}
		NormalizeActivity(&a)
		if a.ClaimMode != "red_packet" {
			return ErrActivityNotFound
		}
		var own []model.Claim
		if e := tx.Where("activity_id = ? AND user_id = ?", id, userID).Order("seq asc").Find(&own).Error; e != nil {
			return e
		}
		if len(own) == 0 {
			return ErrPacketParticipant
		}
		ids := make([]int64, 0, len(own))
		for _, c := range own {
			ids = append(ids, c.ID)
		}
		var grants []model.Grant
		if e := tx.Select("ref_id", "status").Where("type = ? AND user_id = ? AND ref_id IN ?", "activity", userID, ids).Find(&grants).Error; e != nil {
			return e
		}
		statuses := map[int64]string{}
		for _, g := range grants {
			statuses[g.RefID] = g.Status
		}
		for _, c := range own {
			status := statuses[c.ID]
			if status == "" {
				status = GrantStatusPending
			}
			out.OwnClaims = append(out.OwnClaims, PacketOwnClaim{c.ID, c.Seq, c.Quota, c.CreatedAt, status})
		}
		remaining := a.TotalCount - a.ClaimedCount
		if remaining < 0 {
			remaining = 0
		}
		progress := 0.0
		if a.TotalCount > 0 {
			progress = float64(a.ClaimedCount) / float64(a.TotalCount)
		}
		out.Summary = PublicActivity{Activity: a, Status: ActivityClaimAvailability(&a, now), Remaining: remaining, Claimed: a.ClaimedCount, Progress: progress, StartAtUnix: a.StartAt.Unix(), EndAtUnix: a.EndAt.Unix(), UserClaimCount: len(own), UserClaimLimitReached: len(own) >= a.PerUserLimit}
		if e := tx.Model(&model.Claim{}).Where("activity_id = ?", id).Count(&out.Total).Error; e != nil {
			return e
		}
		best := int64(0)
		if a.PacketMode == "random" && a.ClaimedCount == a.TotalCount {
			if e := tx.Model(&model.Claim{}).Select("COALESCE(MAX(quota),0)").Where("activity_id = ?", id).Scan(&best).Error; e != nil {
				return e
			}
		}
		var claims []model.Claim
		if e := tx.Where("activity_id = ?", id).Order("id desc").Offset((page - 1) * size).Limit(size).Find(&claims).Error; e != nil {
			return e
		}
		userIDs := make([]int64, 0, len(claims))
		for _, c := range claims {
			userIDs = append(userIDs, c.UserID)
		}
		var users []model.User
		if len(userIDs) > 0 {
			if e := tx.Select("id", "display_name", "linux_do_name", "avatar_url").Where("id IN ?", userIDs).Find(&users).Error; e != nil {
				return e
			}
		}
		identities := map[int64]model.User{}
		for _, u := range users {
			identities[u.ID] = u
		}
		for _, c := range claims {
			u := identities[c.UserID]
			name := strings.TrimSpace(u.DisplayName)
			if name == "" {
				name = strings.TrimSpace(u.LinuxDOName)
			}
			if name == "" {
				name = "幸运用户"
			}
			out.Items = append(out.Items, PacketParticipant{c.ID, name, u.AvatarURL, c.Quota, c.CreatedAt, best > 0 && c.Quota == best})
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return out, nil
}
