package service

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"

	"welfare/model"

	"github.com/glebarez/sqlite"
	"gorm.io/gorm"
)

// mockNewAPI is a configurable httptest server mimicking design.md §4.2
// POST /api/user/manage.
type mockNewAPI struct {
	srv          *httptest.Server
	callCount    int64
	failNext     int64 // fail the first N calls
	successCalls int64
	tempCalls    int64 // /api/user/temporary_quota 命中次数
	permCalls    int64 // /api/user/manage 命中次数
	// checkedInToday 控制 GET /api/user/:id 返回的跨系统签到状态;
	// omitCheckinFields=true 时完全不返回这两个字段,模拟旧版 new-api。
	checkedInToday    int64
	omitCheckinFields int64
}

func newMockNewAPI() *mockNewAPI {
	m := &mockNewAPI{}
	mux := http.NewServeMux()
	handle := func(counter *int64) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			atomic.AddInt64(counter, 1)
			n := atomic.AddInt64(&m.callCount, 1)
			if atomic.LoadInt64(&m.failNext) >= n {
				writeGrantJSON(w, http.StatusOK, false, "模拟发放失败")
				return
			}
			atomic.AddInt64(&m.successCalls, 1)
			writeGrantJSON(w, http.StatusOK, true, "")
		}
	}
	mux.HandleFunc("/api/user/manage", handle(&m.permCalls))
	mux.HandleFunc("/api/user/temporary_quota", handle(&m.tempCalls))
	// GET /api/user/:id —— 跨系统防重签探测用。
	mux.HandleFunc("/api/user/", func(w http.ResponseWriter, r *http.Request) {
		data := map[string]any{"id": 42, "username": "alice", "quota": 100, "status": 1}
		if atomic.LoadInt64(&m.omitCheckinFields) == 0 {
			data["checked_in_today"] = atomic.LoadInt64(&m.checkedInToday) == 1
			data["today_checkin_quota_type"] = "temporary"
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"success": true, "message": "", "data": data})
	})
	m.srv = httptest.NewServer(mux)
	return m
}

func (m *mockNewAPI) Close() { m.srv.Close() }

func (m *mockNewAPI) URL() string { return m.srv.URL }

func writeGrantJSON(w http.ResponseWriter, code int, success bool, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(map[string]any{"success": success, "message": msg, "data": nil})
}

func grantDB(t *testing.T) *gorm.DB {
	t.Helper()
	dsn := fmt.Sprintf("file:grant-test-%d?mode=memory&cache=shared", atomic.AddInt64(&grantTestCounter, 1))
	db, err := gorm.Open(sqlite.Open(dsn), &gorm.Config{})
	if err != nil {
		t.Fatalf("open sqlite: %v", err)
	}
	if err := model.Migrate(db); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	return db
}

var grantTestCounter int64

func setupGrantService(t *testing.T) (*GrantService, *mockNewAPI, *gorm.DB) {
	t.Helper()
	mock := newMockNewAPI()
	db := grantDB(t)
	svc := NewGrantService(db, NewNewAPIClient(mock.URL(), "pat"))
	return svc, mock, db
}

// TestConcurrentDuplicateGrantID ensures two racing grants with the same
// (type, ref_id) produce exactly one pending row.
func TestConcurrentDuplicateGrantID(t *testing.T) {
	svc, mock, db := setupGrantService(t)
	defer mock.Close()

	// Sequential duplicate: second insert must be rejected by uk_type_ref.
	makeGrant := func() *model.Grant {
		return &model.Grant{UserID: 1, NewapiUserID: 42, Type: "checkin", RefID: 777, Quota: 100}
	}
	err1 := db.Transaction(func(tx *gorm.DB) error { return svc.GrantTx(tx, makeGrant()) })
	err2 := db.Transaction(func(tx *gorm.DB) error { return svc.GrantTx(tx, makeGrant()) })
	if err1 != nil {
		t.Fatalf("first insert should succeed: %v", err1)
	}
	if !errors.Is(err2, ErrDuplicateGrant) {
		t.Fatalf("second insert should be ErrDuplicateGrant, got %v", err2)
	}

	// Concurrent duplicate: independently of which transaction loses, the DB
	// must never end up with more than one row.
	var wg sync.WaitGroup
	results := make([]error, 4)
	for i := 0; i < 4; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			results[i] = db.Transaction(func(tx *gorm.DB) error {
				return svc.GrantTx(tx, &model.Grant{UserID: 1, NewapiUserID: 42, Type: "checkin", RefID: 888, Quota: 100})
			})
		}(i)
	}
	wg.Wait()

	var count int64
	if err := db.Model(&model.Grant{}).Where("type = ? AND ref_id = ?", "checkin", 888).Count(&count).Error; err != nil {
		t.Fatalf("count: %v", err)
	}
	if count != 1 {
		// At most one row may be created even if the losing tx reports a lock
		// error instead of a clean duplicate error.
		var total int64
		db.Model(&model.Grant{}).Count(&total)
		t.Fatalf("expected exactly 1 row for (checkin,888), got %d (total rows %d, results %v)", count, total, results)
	}
}

// TestGrantFailureKeepsBusinessRecord verifies that when the outbound call
// fails the grant is marked failed and the business record is preserved.
func TestGrantFailureKeepsBusinessRecord(t *testing.T) {
	svc, mock, db := setupGrantService(t)
	defer mock.Close()
	mock.failNext = 1

	var checkin model.Checkin
	var grant model.Grant
	err := db.Transaction(func(tx *gorm.DB) error {
		if err := tx.Create(&checkin).Error; err != nil {
			return err
		}
		grant = model.Grant{UserID: 1, NewapiUserID: 42, Type: "checkin", RefID: checkin.ID, Quota: 100}
		return svc.GrantTx(tx, &grant)
	})
	if err != nil {
		t.Fatalf("tx: %v", err)
	}

	if err := svc.ExecuteAfterCommit(&grant); err == nil {
		t.Fatalf("expected outbound failure to surface an error")
	}

	var g model.Grant
	if err := db.First(&g, grant.ID).Error; err != nil {
		t.Fatalf("load grant: %v", err)
	}
	if g.Status != GrantStatusFailed || g.Error == "" {
		t.Fatalf("expected failed with error, got status=%s error=%q", g.Status, g.Error)
	}
	// Business record preserved.
	var persisted model.Checkin
	if err := db.First(&persisted, checkin.ID).Error; err != nil {
		t.Fatalf("business record should be preserved: %v", err)
	}
}

// TestGrantSuccessMarksSuccess verifies the happy path.
func TestGrantSuccessMarksSuccess(t *testing.T) {
	svc, mock, db := setupGrantService(t)
	defer mock.Close()

	var grant model.Grant
	err := db.Transaction(func(tx *gorm.DB) error {
		grant = model.Grant{UserID: 1, NewapiUserID: 42, Type: "manual", RefID: NewManualRefID(), Quota: 100}
		return svc.GrantTx(tx, &grant)
	})
	if err != nil {
		t.Fatalf("tx: %v", err)
	}
	if err := svc.ExecuteAfterCommit(&grant); err != nil {
		t.Fatalf("execute: %v", err)
	}
	var g model.Grant
	db.First(&g, grant.ID)
	if g.Status != GrantStatusSuccess {
		t.Fatalf("expected success, got %s", g.Status)
	}
	if atomic.LoadInt64(&mock.successCalls) != 1 {
		t.Fatalf("expected 1 successful outbound call, got %d", mock.successCalls)
	}
}

// TestRetryCASConcurrent verifies only one concurrent retry executes the
// outbound call for the same failed grant.
func TestRetryCASConcurrent(t *testing.T) {
	svc, mock, db := setupGrantService(t)
	defer mock.Close()
	mock.failNext = 1 // first call (initial grant) fails

	gr := &model.Grant{UserID: 1, NewapiUserID: 42, Type: "activity", RefID: 555, Quota: 100}
	if err := svc.Grant(gr); err == nil {
		t.Fatalf("initial grant should surface the outbound failure")
	}
	var g model.Grant
	if err := db.First(&g, gr.ID).Error; err != nil {
		t.Fatalf("load: %v", err)
	}
	if g.Status != GrantStatusFailed {
		t.Fatalf("expected failed before retry, got %s", g.Status)
	}

	// Now the mock succeeds; two retries race. Exactly one may execute.
	var wg sync.WaitGroup
	errs := make([]error, 2)
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			errs[i] = svc.Retry(gr.ID)
		}(i)
	}
	wg.Wait()

	db.First(&g, gr.ID)
	if g.Status != GrantStatusSuccess {
		t.Fatalf("expected success after retry, got %s (errors %v)", g.Status, errs)
	}
	// Only the initial (failed) call + one successful retry call.
	if atomic.LoadInt64(&mock.callCount) != 2 {
		t.Fatalf("expected exactly 2 outbound calls total (1 failed + 1 retry), got %d", mock.callCount)
	}
	oneErr := errors.Is(errs[0], ErrNotFailed) || errors.Is(errs[1], ErrNotFailed)
	if !oneErr {
		t.Fatalf("expected one retry to be rejected with ErrNotFailed, got %v", errs)
	}
}

// TestRetryNotFailedRejected verifies retry on a success grant is a no-op.
func TestRetryNotFailedRejected(t *testing.T) {
	svc, mock, _ := setupGrantService(t)
	defer mock.Close()

	gr := &model.Grant{UserID: 1, NewapiUserID: 42, Type: "manual", RefID: NewManualRefID(), Quota: 100}
	if err := svc.Grant(gr); err != nil {
		t.Fatalf("grant: %v", err)
	}
	if err := svc.Retry(gr.ID); !errors.Is(err, ErrNotFailed) {
		t.Fatalf("expected ErrNotFailed, got %v", err)
	}
}

// TestGrantQuotaTypeRouting 验证发放器按流水记录的额度类型选接口,
// 且存量流水(quota_type 为空)按永久额度处理。
func TestGrantQuotaTypeRouting(t *testing.T) {
	cases := []struct {
		name      string
		quotaType string
		wantTemp  int64
		wantPerm  int64
	}{
		{"限时额度走 temporary_quota", QuotaTypeTemporary, 1, 0},
		{"永久额度走 manage", QuotaTypePermanent, 0, 1},
		{"存量空值按永久处理", "", 0, 1},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			svc, mock, _ := setupGrantService(t)
			defer mock.Close()

			gr := &model.Grant{UserID: 1, NewapiUserID: 42, Type: "manual",
				RefID: NewManualRefID(), Quota: 100, QuotaType: tc.quotaType}
			if err := svc.Grant(gr); err != nil {
				t.Fatalf("grant: %v", err)
			}
			if got := atomic.LoadInt64(&mock.tempCalls); got != tc.wantTemp {
				t.Fatalf("temporary_quota 调用次数 = %d, want %d", got, tc.wantTemp)
			}
			if got := atomic.LoadInt64(&mock.permCalls); got != tc.wantPerm {
				t.Fatalf("manage 调用次数 = %d, want %d", got, tc.wantPerm)
			}
		})
	}
}

// TestRetryUsesPersistedQuotaType 验证重试沿用流水当初记录的额度类型:
// 站长在失败后把签到配置改回永久额度,补发仍必须走限时接口。
func TestRetryUsesPersistedQuotaType(t *testing.T) {
	svc, mock, db := setupGrantService(t)
	defer mock.Close()
	mock.failNext = 1 // 首次发放失败

	gr := &model.Grant{UserID: 1, NewapiUserID: 42, Type: "checkin", RefID: 901,
		Quota: 100, QuotaType: QuotaTypeTemporary}
	if err := svc.Grant(gr); err == nil {
		t.Fatalf("首次发放应当暴露外呼失败")
	}

	// 模拟站长把签到配置改回永久额度——重试不应受此影响。
	cfg := DefaultCheckinConfig()
	cfg.RewardType = QuotaTypePermanent
	if err := SaveCheckinConfig(db, cfg); err != nil {
		t.Fatalf("save config: %v", err)
	}

	if err := svc.Retry(gr.ID); err != nil {
		t.Fatalf("retry: %v", err)
	}
	var g model.Grant
	db.First(&g, gr.ID)
	if g.Status != GrantStatusSuccess {
		t.Fatalf("重试后应为 success,实际 %s", g.Status)
	}
	if got := atomic.LoadInt64(&mock.tempCalls); got != 2 {
		t.Fatalf("两次都应打到 temporary_quota,实际 %d", got)
	}
	if got := atomic.LoadInt64(&mock.permCalls); got != 0 {
		t.Fatalf("不应打到永久额度接口,实际 %d", got)
	}
}
