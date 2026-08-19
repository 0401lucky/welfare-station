package service

import (
	"errors"
	"sync/atomic"
	"time"

	"welfare/model"

	"gorm.io/gorm"
)

// Grant statuses (w_grants.status).
const (
	GrantStatusPending = "pending"
	GrantStatusSuccess = "success"
	GrantStatusFailed  = "failed"
)

// 额度类型(w_grants.quota_type):永久余额 / 今日限时额度。
const (
	QuotaTypePermanent = "permanent"
	QuotaTypeTemporary = "temporary"
)

// NormalizeQuotaType 把空值/未知值一律按永久额度解释,保证存量流水与旧配置兼容。
func NormalizeQuotaType(t string) string {
	if t == QuotaTypeTemporary {
		return QuotaTypeTemporary
	}
	return QuotaTypePermanent
}

// ErrNotFailed is returned by Retry when the grant is not in a failed state
// (e.g. a concurrent retry already picked it up, or it already succeeded).
var ErrNotFailed = errors.New("grant is not failed")

// ErrDuplicateGrant is wrapped by callers when the pending-grant insert hits
// the uk_type_ref unique constraint (means the action was already processed).
var ErrDuplicateGrant = errors.New("grant already exists")

// manualRefCounter produces unique ref ids for manual grants so the
// uk_type_ref unique constraint stays valid (design.md §3 note).
var manualRefCounter uint64

// NewManualRefID returns a process-unique int64 ref id (snowflake-ish).
func NewManualRefID() int64 {
	seq := atomic.AddUint64(&manualRefCounter, 1)
	v := uint64(time.Now().UnixNano())<<20 | (seq & 0xFFFFF)
	return int64(v & 0x7FFFFFFFFFFFFFFF)
}

// GrantService is the single payout path for checkin / activity / manual
// grants. It implements design.md §8:
//  1. pending grant inserted inside the caller's business transaction
//  2. synchronous outbound add_quota AFTER commit
//  3. success/failed written back; retry is CAS-protected (idempotent)
type GrantService struct {
	db     *gorm.DB
	newapi *NewAPIClient
}

func NewGrantService(db *gorm.DB, newapi *NewAPIClient) *GrantService {
	return &GrantService{db: db, newapi: newapi}
}

// GrantTx inserts a pending grant inside an already-open transaction. The
// caller is responsible for inserting the business record in the same tx, so
// "business record + pending grant" commit atomically. The uk_type_ref unique
// constraint intercepts concurrent duplicates here.
func (g *GrantService) GrantTx(tx *gorm.DB, gr *model.Grant) error {
	gr.Status = GrantStatusPending
	gr.Error = ""
	gr.QuotaType = NormalizeQuotaType(gr.QuotaType)
	if err := tx.Create(gr).Error; err != nil {
		if isDuplicateErr(err) {
			return ErrDuplicateGrant
		}
		return err
	}
	return nil
}

// Grant inserts and executes a standalone grant (used by manual payouts that
// have no business record of their own). On return gr holds the fresh row so
// callers can inspect the final status.
func (g *GrantService) Grant(gr *model.Grant) error {
	err := g.db.Transaction(func(tx *gorm.DB) error {
		return g.GrantTx(tx, gr)
	})
	if err != nil {
		return err
	}
	callErr := g.ExecuteAfterCommit(gr)
	if g.db.First(gr, gr.ID).Error != nil {
		return errLoadGrant
	}
	return callErr
}

// errLoadGrant reports a failure to reload a grant row after execution.
var errLoadGrant = errors.New("grant persisted but failed to reload")

// ExecuteAfterCommit performs the outbound add_quota call and writes back the
// result. The grant row must already be committed as pending. The function
// never deletes or rolls back the grant on failure — the business record stays
// and the payout is recovered by Retry (design.md §8).
//
// It returns the outbound call error (nil on success) so controllers can tell
// the user "发放遇到问题,会尽快补发"; the failed status is already persisted.
func (g *GrantService) ExecuteAfterCommit(gr *model.Grant) error {
	callErr := g.callNewAPI(gr)
	if err := g.writeResult(gr.ID, callErr); err != nil {
		return err
	}
	return callErr
}

// callNewAPI 按流水自身记录的额度类型选择发放接口。重试路径同样走这里,
// 因此补发的类型与当初签到时一致,不受站长事后改配置影响。
func (g *GrantService) callNewAPI(gr *model.Grant) error {
	if NormalizeQuotaType(gr.QuotaType) == QuotaTypeTemporary {
		return g.newapi.AddTemporaryQuota(gr.NewapiUserID, gr.Quota)
	}
	return g.newapi.AddQuota(gr.NewapiUserID, gr.Quota)
}

// ExecuteGrant is a convenience that loads the grant by id and executes it.
// Used by services that already hold the grant's id.
func (g *GrantService) ExecuteGrant(id int64) error {
	var gr model.Grant
	if err := g.db.First(&gr, id).Error; err != nil {
		return err
	}
	return g.ExecuteAfterCommit(&gr)
}

// Retry re-executes a failed grant. It first CAS-transitions failed→pending so
// concurrent retries on the same grant can never both execute (design.md §8.4).
func (g *GrantService) Retry(id int64) error {
	now := time.Now()
	res := g.db.Model(&model.Grant{}).
		Where("id = ? AND status = ?", id, GrantStatusFailed).
		Updates(map[string]any{"status": GrantStatusPending, "updated_at": now})
	if res.Error != nil {
		return res.Error
	}
	if res.RowsAffected == 0 {
		return ErrNotFailed
	}

	var gr model.Grant
	if err := g.db.First(&gr, id).Error; err != nil {
		return err
	}
	if err := g.db.Model(&model.Grant{}).Where("id = ?", id).Update("retried_at", &now).Error; err != nil {
		return err
	}
	return g.ExecuteAfterCommit(&gr)
}

func (g *GrantService) writeResult(id int64, callErr error) error {
	updates := map[string]any{"updated_at": time.Now()}
	if callErr == nil {
		updates["status"] = GrantStatusSuccess
		updates["error"] = ""
	} else {
		updates["status"] = GrantStatusFailed
		msg := callErr.Error()
		if len(msg) > 500 {
			msg = msg[:500]
		}
		updates["error"] = msg
	}
	return g.db.Model(&model.Grant{}).Where("id = ?", id).Updates(updates).Error
}

// isDuplicateErr reports whether a gorm error is a unique-constraint violation
// (dialect-independent: detects both MySQL error 1062 and SQLite 2067).
func isDuplicateErr(err error) bool {
	if err == nil {
		return false
	}
	s := err.Error()
	return containsFold(s, "duplicate") || containsFold(s, "unique constraint") ||
		containsFold(s, "unique index") || containsFold(s, "1062") || containsFold(s, "2067")
}

func containsFold(s, sub string) bool {
	if len(s) < len(sub) {
		return false
	}
	ls := lowerASCII(s)
	lsub := lowerASCII(sub)
	for i := 0; i+len(lsub) <= len(ls); i++ {
		if ls[i:i+len(lsub)] == lsub {
			return true
		}
	}
	return false
}

func lowerASCII(s string) string {
	b := []byte(s)
	for i, ch := range b {
		if ch >= 'A' && ch <= 'Z' {
			b[i] = ch + 32
		}
	}
	return string(b)
}
