package service

import (
	"errors"
	"gorm.io/driver/mysql"
	"gorm.io/gorm"
	"net/http"
	"net/http/httptest"
	"os"
	"sync"
	"sync/atomic"
	"testing"
	"time"
	"welfare/model"
)

func TestPacketAllocationAndValidation(t *testing.T) {
	for _, pool := range []struct {
		total int64
		count int
		min   int64
	}{{7, 7, 1}, {101, 8, 2}, {1, 1, 1}, {MaxActivityInteger, 31, 1}} {
		remaining := pool.total
		for n := pool.count; n > 0; n-- {
			amount, err := packetAmount(remaining, n, pool.min)
			if err != nil || amount < pool.min || amount > remaining-int64(n-1)*pool.min {
				t.Fatalf("invalid allocation: %d %v", amount, err)
			}
			if n > 1 && amount > 2*remaining/int64(n) {
				t.Fatal("double average exceeded")
			}
			remaining -= amount
		}
		if remaining != 0 {
			t.Fatal("sum not conserved")
		}
	}
	for _, a := range []model.Activity{
		{ClaimMode: "bogus", Quota: 1, TotalCount: 1},
		{ClaimMode: "red_packet", PacketMode: "random", TotalQuota: 9, TotalCount: 10, MinQuota: 1},
		{ClaimMode: "red_packet", Quota: MaxActivityInteger, TotalCount: 2},
	} {
		a.Title = "test"
		if ValidateActivity(&a, 500000) == nil {
			t.Fatal("invalid config accepted")
		}
	}
	a := model.Activity{Title: "test", ClaimMode: "red_packet", PacketMode: "random", TotalQuota: 10, TotalCount: 2}
	if err := ValidateActivity(&a, 100); err != nil || a.MinQuota != 1 {
		t.Fatalf("minimum conversion: %+v %v", a, err)
	}
	for _, raw := range []string{"javascript:alert(1)", "//evil.example/a", "/\\evil.example/a", "http://example.com/a"} {
		if ValidActivityCover(raw) {
			t.Fatalf("unsafe cover %s", raw)
		}
	}
}

func packetFixture(t *testing.T, db *gorm.DB) model.Activity {
	a := newActivity(t, db, 7, 10, 0, time.Hour, time.Hour)
	a.ClaimMode = "red_packet"
	a.PacketMode = "random"
	a.TotalQuota = 101
	a.MinQuota = 2
	a.Quota = 0
	if err := db.Save(&a).Error; err != nil {
		t.Fatal(err)
	}
	return a
}

func TestPacketReplayDetailsAndLocks(t *testing.T) {
	db := activityTestDB(t)
	mock := newActivityMockNewAPI()
	defer mock.Close()
	client := NewNewAPIClient(mock.srv.URL, "pat")
	grants := NewGrantService(db, client)
	a := packetFixture(t, db)
	u := makeUser(db, 1, 1, 1001, 1)
	if _, err := DoClaim(db, grants, client, &u, a.ID, time.Now()); !errors.Is(err, ErrPacketSequence) {
		t.Fatal(err)
	}
	if _, err := GetPacketDetail(db, a.ID, u.ID, 1, 1, time.Now()); !errors.Is(err, ErrPacketParticipant) {
		t.Fatal(err)
	}
	first, err := DoClaim(db, grants, client, &u, a.ID, time.Now(), 1)
	if err != nil {
		t.Fatal(err)
	}
	var current model.Activity
	db.First(&current, a.ID)
	changed := current
	changed.TotalQuota++
	if _, _, err := UpdateActivity(db, a.ID, changed); !errors.Is(err, ErrActivityRulesLocked) {
		t.Fatal(err)
	}
	changed = current
	changed.EndAt = time.Now().Add(-time.Minute)
	changed.PerUserLimit = 1
	if _, _, err := UpdateActivity(db, a.ID, changed); err != nil {
		t.Fatal(err)
	}
	replay, err := DoClaim(db, grants, NewNewAPIClient("http://127.0.0.1:1", "pat"), &u, a.ID, time.Now(), 1)
	if err != nil || !replay.Replayed || replay.Claim.ID != first.Claim.ID || replay.Grant.Status != GrantStatusSuccess {
		t.Fatalf("replay %v %+v", err, replay)
	}
	if atomic.LoadInt64(&mock.successCalls) != 1 {
		t.Fatal("replay paid again")
	}
	detail, err := GetPacketDetail(db, a.ID, u.ID, 1, 1, time.Now())
	if err != nil || detail.Items[0].IsBest || detail.OwnClaims[0].GrantStatus != GrantStatusSuccess {
		t.Fatalf("detail %+v %v", detail, err)
	}
	changed.EndAt = time.Now().Add(time.Hour)
	changed.PerUserLimit = 10
	if _, _, err := UpdateActivity(db, a.ID, changed); err != nil {
		t.Fatal(err)
	}
	for seq := 2; seq <= 7; seq++ {
		if _, err := DoClaim(db, grants, client, &u, a.ID, time.Now(), seq); err != nil {
			t.Fatal(err)
		}
	}
	detail, err = GetPacketDetail(db, a.ID, u.ID, 1, 1, time.Now())
	if err != nil || detail.Summary.ClaimedQuota != 101 || detail.Total != 7 || len(detail.OwnClaims) != 7 {
		t.Fatalf("drain %+v %v", detail, err)
	}
	var best int64
	db.Model(&model.Claim{}).Select("MAX(quota)").Where("activity_id = ?", a.ID).Scan(&best)
	for page := 1; page <= 7; page++ {
		d, e := GetPacketDetail(db, a.ID, u.ID, page, 1, time.Now())
		if e != nil || d.Items[0].IsBest != (d.Items[0].Quota == best) {
			t.Fatal("global best paging", e)
		}
	}
}

func runPacketConcurrency(t *testing.T, db *gorm.DB) {
	t.Helper()
	mock := newActivityMockNewAPI()
	defer mock.Close()
	client := NewNewAPIClient(mock.srv.URL, "pat")
	grants := NewGrantService(db, client)
	a := packetFixture(t, db)
	u := makeUser(db, 100+int(a.ID), 1, 1000+a.ID, 1)
	var wg sync.WaitGroup
	results := make([]*ClaimResult, 12)
	errs := make([]error, 12)
	for i := range results {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			results[i], errs[i] = DoClaim(db, grants, client, &u, a.ID, time.Now(), 1)
		}(i)
	}
	wg.Wait()
	for i, e := range errs {
		if e != nil || results[i].Claim.ID != results[0].Claim.ID {
			t.Fatalf("duplicate %d %v", i, e)
		}
	}
	if atomic.LoadInt64(&mock.successCalls) != 1 {
		t.Fatal("duplicate payout")
	}
	// Competing first claim and financial edit must serialize; either legal order
	// leaves a fully conserved pool, and an edit after a claim must be rejected.
	b := packetFixture(t, db)
	desired := b
	desired.TotalQuota = 202
	var editErr, claimErr error
	wg.Add(2)
	go func() { defer wg.Done(); _, _, editErr = UpdateActivity(db, b.ID, desired) }()
	go func() { defer wg.Done(); _, claimErr = DoClaim(db, grants, client, &u, b.ID, time.Now(), 1) }()
	wg.Wait()
	if claimErr != nil {
		t.Fatal(claimErr)
	}
	if editErr != nil && !errors.Is(editErr, ErrActivityRulesLocked) {
		t.Fatal(editErr)
	}
	var stored model.Activity
	db.First(&stored, b.ID)
	var sum int64
	db.Model(&model.Claim{}).Select("SUM(quota)").Where("activity_id = ?", b.ID).Scan(&sum)
	if stored.ClaimedCount != 1 || stored.ClaimedQuota != sum {
		t.Fatalf("race counters %+v sum=%d", stored, sum)
	}
	// More distinct users than remaining copies.
	users := make([]model.User, 12)
	for i := range users {
		users[i] = makeUser(db, 10000+int(b.ID)*100+i, 1, 10000+b.ID*100+int64(i), 1)
	}
	errs = make([]error, 12)
	for i := range users {
		wg.Add(1)
		go func(i int) { defer wg.Done(); _, errs[i] = DoClaim(db, grants, client, &users[i], b.ID, time.Now(), 1) }(i)
	}
	wg.Wait()
	successes := 0
	for _, e := range errs {
		if e == nil {
			successes++
		} else if !errors.Is(e, ErrActivitySoldOut) {
			t.Fatal(e)
		}
	}
	db.First(&stored, b.ID)
	if successes != 6 || stored.ClaimedCount != 7 || stored.ClaimedQuota != stored.TotalQuota {
		t.Fatalf("oversell %+v successes %d", stored, successes)
	}
}

func TestPacketConcurrentSQLite(t *testing.T) { runPacketConcurrency(t, activityTestDB(t)) }

func TestPacketTiedBestAndIdentityFallback(t *testing.T) {
	db := activityTestDB(t)
	a := packetFixture(t, db)
	a.TotalCount, a.ClaimedCount, a.TotalQuota, a.ClaimedQuota, a.MinQuota = 3, 2, 3, 2, 1
	u := makeUser(db, 1, 1, 1001, 1)
	if err := db.Save(&a).Error; err != nil {
		t.Fatal(err)
	}
	// The second participant no longer has a profile; payout details stay private.
	claims := []model.Claim{{ActivityID: a.ID, UserID: u.ID, Quota: 1, Seq: 1}, {ActivityID: a.ID, UserID: u.ID + 100, Quota: 1, Seq: 1}}
	if err := db.Create(&claims).Error; err != nil {
		t.Fatal(err)
	}
	detail, err := GetPacketDetail(db, a.ID, u.ID, 1, 20, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	for _, row := range detail.Items {
		if row.IsBest {
			t.Fatal("best must remain unset before the pool is drained")
		}
	}
	if detail.Items[0].Nickname != "幸运用户" || detail.OwnClaims[0].GrantStatus != GrantStatusPending {
		t.Fatalf("missing profile/grant fallback: %+v", detail)
	}
	third := model.Claim{ActivityID: a.ID, UserID: u.ID, Quota: 1, Seq: 2}
	if err := db.Create(&third).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Model(&a).Updates(map[string]any{"claimed_count": 3, "claimed_quota": 3, "status": ActivityStatusOff}).Error; err != nil {
		t.Fatal(err)
	}
	for page := 1; page <= 3; page++ {
		detail, err = GetPacketDetail(db, a.ID, u.ID, page, 1, time.Now())
		if err != nil || len(detail.Items) != 1 || !detail.Items[0].IsBest || len(detail.OwnClaims) != 2 {
			t.Fatalf("all tied claims must remain visible and best off-shelf: %+v %v", detail, err)
		}
	}
}

func TestPacketFailureAndRollback(t *testing.T) {
	db := activityTestDB(t)
	a := packetFixture(t, db)
	u := makeUser(db, 1, 1, 2001, 1)
	var calls int64
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPost {
			atomic.AddInt64(&calls, 1)
			writeGrantJSON(w, 200, false, "unavailable")
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"success":true,"data":{"status":1}}`))
	}))
	defer srv.Close()
	client := NewNewAPIClient(srv.URL, "pat")
	grants := NewGrantService(db, client)
	first, err := DoClaim(db, grants, client, &u, a.ID, time.Now(), 1)
	if err != nil || first.OutErr == nil || first.Grant.Status != GrantStatusFailed {
		t.Fatalf("failed payout %+v %v", first, err)
	}
	again, err := DoClaim(db, grants, client, &u, a.ID, time.Now(), 1)
	if err != nil || !again.Replayed || again.Claim.Quota != first.Claim.Quota || atomic.LoadInt64(&calls) != 1 {
		t.Fatal("failed replay rerolled", err)
	}
	// A grant insertion failure rolls back both claim and reserved budget.
	if err := db.Callback().Create().Before("gorm:create").Register("test:reject-grant", func(tx *gorm.DB) {
		if tx.Statement.Table == "w_grants" {
			tx.AddError(errors.New("injected grant failure"))
		}
	}); err != nil {
		t.Fatal(err)
	}
	_, err = DoClaim(db, grants, client, &u, a.ID, time.Now(), 2)
	if err == nil {
		t.Fatal("expected rollback")
	}
	var stored model.Activity
	db.First(&stored, a.ID)
	if stored.ClaimedCount != 1 || stored.ClaimedQuota != first.Claim.Quota || atomic.LoadInt64(&calls) != 1 {
		t.Fatal("rollback consumed budget")
	}
}

func TestPacketConcurrentMySQL(t *testing.T) {
	dsn := os.Getenv("ACTIVITY_TEST_MYSQL_DSN")
	if dsn == "" {
		t.Skip("set ACTIVITY_TEST_MYSQL_DSN to a disposable database")
	}
	db, err := gorm.Open(mysql.Open(dsn), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	if err := model.Migrate(db); err != nil {
		t.Fatal(err)
	}
	runPacketConcurrency(t, db)
}
