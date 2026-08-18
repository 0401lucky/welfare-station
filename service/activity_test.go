package service

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"welfare/model"

	"github.com/glebarez/sqlite"
	"gorm.io/gorm"
)

// activityMockNewAPI serves GET /api/user/:id (for status check) and
// POST /api/user/manage (for payout).
type activityMockNewAPI struct {
	srv          *httptest.Server
	successCalls int64
	newapiStatus int // user status returned by GET /api/user/:id
}

func newActivityMockNewAPI() *activityMockNewAPI {
	m := &activityMockNewAPI{newapiStatus: 1}
	mux := http.NewServeMux()
	mux.HandleFunc("/api/user/manage", func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt64(&m.successCalls, 1)
		writeGrantJSON(w, http.StatusOK, true, "")
	})
	mux.HandleFunc("/api/user/", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"success": true, "message": "", "data": map[string]any{
				"id": 42, "username": "alice", "quota": 0, "status": m.newapiStatus, "linux_do_id": "10001",
			},
		})
	})
	m.srv = httptest.NewServer(mux)
	return m
}

func (m *activityMockNewAPI) Close() { m.srv.Close() }

func activityTestDB(t *testing.T) *gorm.DB {
	t.Helper()
	dsn := fmt.Sprintf("file:act-test-%d?mode=memory&cache=shared", atomic.AddInt64(&grantTestCounter, 1))
	db, err := gorm.Open(sqlite.Open(dsn), &gorm.Config{})
	if err != nil {
		t.Fatalf("open sqlite: %v", err)
	}
	if err := model.Migrate(db); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	return db
}

func newActivity(t *testing.T, db *gorm.DB, total, perUser, minTrust int, startAgo, endAhead time.Duration) model.Activity {
	t.Helper()
	now := time.Now()
	a := model.Activity{
		Title:         "测试活动",
		Quota:         500,
		TotalCount:    total,
		PerUserLimit:  perUser,
		MinTrustLevel: minTrust,
		StartAt:       now.Add(-startAgo),
		EndAt:         now.Add(endAhead),
		Status:        ActivityStatusOn,
	}
	if err := db.Create(&a).Error; err != nil {
		t.Fatalf("create activity: %v", err)
	}
	return a
}

func makeUser(db *gorm.DB, id, trust int, newapiID int64, status int) model.User {
	u := model.User{LinuxDOID: fmt.Sprintf("u%d", id), LinuxDOName: "u", TrustLevel: trust, Status: status, NewapiUserID: int64Ptr(newapiID)}
	db.Create(&u)
	return u
}

// TestConcurrentClaimNoOvershoot: 3 users race for an activity with 2 copies.
func TestConcurrentClaimNoOvershoot(t *testing.T) {
	mock := newActivityMockNewAPI()
	defer mock.Close()
	db := activityTestDB(t)
	a := newActivity(t, db, 2, 1, 0, time.Hour, time.Hour)
	svc := NewGrantService(db, NewNewAPIClient(mock.srv.URL, "pat"))

	users := []model.User{
		makeUser(db, 1, 1, 101, 1),
		makeUser(db, 2, 1, 102, 1),
		makeUser(db, 3, 1, 103, 1),
	}

	var wg sync.WaitGroup
	results := make([]error, 3)
	for i := 0; i < 3; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			_, results[i] = DoClaim(db, svc, NewNewAPIClient(mock.srv.URL, "pat"), &users[i], a.ID, time.Now())
		}(i)
	}
	wg.Wait()

	ok := 0
	for _, err := range results {
		if err == nil {
			ok++
		} else if err != ErrActivitySoldOut && err != ErrClaimLimit {
			t.Fatalf("unexpected error: %v", err)
		}
	}
	if ok != 2 {
		t.Fatalf("expected exactly 2 successful claims, got %d (results %v)", ok, results)
	}

	var a2 model.Activity
	db.First(&a2, a.ID)
	if a2.ClaimedCount != 2 {
		t.Fatalf("expected claimed_count=2 (no overshoot), got %d", a2.ClaimedCount)
	}
	if atomic.LoadInt64(&mock.successCalls) != 2 {
		t.Fatalf("expected 2 payouts, got %d", mock.successCalls)
	}
}

// TestSameUserDuplicateClaimRejected verifies per-user limit enforcement.
func TestSameUserDuplicateClaimRejected(t *testing.T) {
	mock := newActivityMockNewAPI()
	defer mock.Close()
	db := activityTestDB(t)
	a := newActivity(t, db, 10, 1, 0, time.Hour, time.Hour)
	svc := NewGrantService(db, NewNewAPIClient(mock.srv.URL, "pat"))
	user := makeUser(db, 1, 1, 101, 1)

	if _, err := DoClaim(db, svc, NewNewAPIClient(mock.srv.URL, "pat"), &user, a.ID, time.Now()); err != nil {
		t.Fatalf("first claim: %v", err)
	}
	_, err := DoClaim(db, svc, NewNewAPIClient(mock.srv.URL, "pat"), &user, a.ID, time.Now())
	if err != ErrClaimLimit {
		t.Fatalf("expected ErrClaimLimit, got %v", err)
	}
	var cnt int64
	db.Model(&model.Claim{}).Where("activity_id = ? AND user_id = ?", a.ID, user.ID).Count(&cnt)
	if cnt != 1 {
		t.Fatalf("expected 1 claim row, got %d", cnt)
	}
}

// TestActivityAvailability verifies list status computation.
func TestActivityAvailability(t *testing.T) {
	db := activityTestDB(t)
	now := time.Now()

	// On-shelf, in window.
	ok := model.Activity{Title: "ok", Quota: 10, TotalCount: 10, PerUserLimit: 1, StartAt: now.Add(-time.Hour), EndAt: now.Add(time.Hour), Status: ActivityStatusOn}
	db.Create(&ok)
	// Not started.
	ns := model.Activity{Title: "ns", Quota: 10, TotalCount: 10, PerUserLimit: 1, StartAt: now.Add(time.Hour), EndAt: now.Add(2 * time.Hour), Status: ActivityStatusOn}
	db.Create(&ns)
	// Ended.
	en := model.Activity{Title: "en", Quota: 10, TotalCount: 10, PerUserLimit: 1, StartAt: now.Add(-2 * time.Hour), EndAt: now.Add(-time.Hour), Status: ActivityStatusOn}
	db.Create(&en)
	// Sold out.
	so := model.Activity{Title: "so", Quota: 10, TotalCount: 10, ClaimedCount: 10, PerUserLimit: 1, StartAt: now.Add(-time.Hour), EndAt: now.Add(time.Hour), Status: ActivityStatusOn}
	db.Create(&so)
	// Off-shelf.
	off := model.Activity{Title: "off", Quota: 10, TotalCount: 10, PerUserLimit: 1, StartAt: now.Add(-time.Hour), EndAt: now.Add(time.Hour), Status: ActivityStatusOff}
	db.Create(&off)

	list, err := ListPublicActivities(db, now)
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	got := map[string]string{}
	for _, x := range list {
		got[x.Title] = x.Status
	}
	if got["ok"] != ClaimAvailable {
		t.Errorf("ok should be available, got %s", got["ok"])
	}
	if got["ns"] != ClaimNotStarted {
		t.Errorf("ns should be not_started, got %s", got["ns"])
	}
	if got["en"] != ClaimEnded {
		t.Errorf("en should be ended, got %s", got["en"])
	}
	if got["so"] != ClaimSoldOut {
		t.Errorf("so should be sold_out, got %s", got["so"])
	}
	if _, exists := got["off"]; exists {
		t.Errorf("off-shelf activity must not be listed")
	}
}

// TestClaimTrustGate verifies the min trust-level gate.
func TestClaimTrustGate(t *testing.T) {
	mock := newActivityMockNewAPI()
	defer mock.Close()
	db := activityTestDB(t)
	a := newActivity(t, db, 10, 1, 4, time.Hour, time.Hour)
	svc := NewGrantService(db, NewNewAPIClient(mock.srv.URL, "pat"))
	user := makeUser(db, 1, 2, 101, 1)

	_, err := DoClaim(db, svc, NewNewAPIClient(mock.srv.URL, "pat"), &user, a.ID, time.Now())
	if err != ErrTrustLevelLow {
		t.Fatalf("expected ErrTrustLevelLow, got %v", err)
	}
}

// TestClaimNewAPIStatusGate verifies the new-api status != 1 rejection.
func TestClaimNewAPIStatusGate(t *testing.T) {
	mock := newActivityMockNewAPI()
	defer mock.Close()
	mock.newapiStatus = 2
	db := activityTestDB(t)
	a := newActivity(t, db, 10, 1, 0, time.Hour, time.Hour)
	svc := NewGrantService(db, NewNewAPIClient(mock.srv.URL, "pat"))
	user := makeUser(db, 1, 2, 101, 1)

	_, err := DoClaim(db, svc, NewNewAPIClient(mock.srv.URL, "pat"), &user, a.ID, time.Now())
	if err == nil {
		t.Fatalf("expected rejection when new-api status != 1")
	}
}
