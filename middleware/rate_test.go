package middleware

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"welfare/model"

	"github.com/gin-gonic/gin"
)

// size 返回桶里当前跟踪的 key 数,仅测试用。
func (b *bucket) size() int {
	b.mu.Lock()
	defer b.mu.Unlock()
	return len(b.lastSeen)
}

// TestBucketSweepDropsIdleKeys 验证清理只删长期不活跃的 key,活跃 key 原样保留。
func TestBucketSweepDropsIdleKeys(t *testing.T) {
	b := newBucket(1, 10)
	now := time.Now()

	for i := 0; i < 1000; i++ {
		key := fmt.Sprintf("idle%d", i)
		b.Allow(key)
		b.lastSeen[key] = now.Add(-2 * time.Hour)
	}
	b.Allow("active")

	if got := b.size(); got != 1001 {
		t.Fatalf("清理前 size = %d, want 1001", got)
	}
	if removed := b.sweep(now, time.Hour); removed != 1000 {
		t.Fatalf("removed = %d, want 1000", removed)
	}
	if got := b.size(); got != 1 {
		t.Fatalf("清理后 size = %d, want 1", got)
	}
	if _, ok := b.tokens["active"]; !ok {
		t.Fatal("活跃 key 不应被清理")
	}
	if _, ok := b.tokens["idle0"]; ok {
		t.Fatal("tokens 与 lastSeen 必须一起删,否则照样泄漏")
	}

	// 被清掉的 key 再次出现时按新 key 处理:重新拿满额,与闲置一小时自然回满等价。
	if !b.Allow("idle0") {
		t.Fatal("清理后重新出现的 key 应能通过")
	}
}

// TestBucketSweepKeepsRecentKeys 验证未超过闲置阈值的 key 不会被误删。
func TestBucketSweepKeepsRecentKeys(t *testing.T) {
	b := newBucket(1, 10)
	now := time.Now()
	b.Allow("recent")
	b.lastSeen["recent"] = now.Add(-30 * time.Minute)

	if removed := b.sweep(now, time.Hour); removed != 0 {
		t.Fatalf("removed = %d, want 0", removed)
	}
	if got := b.size(); got != 1 {
		t.Fatalf("size = %d, want 1", got)
	}
}

func TestFeedbackLimiterIsolationAndRefill(t *testing.T) {
	oldFeedback, oldUser, oldIP := FeedbackLimiter, PerUserLimiter, IPLimiter
	oldGame, oldCheckpoint := GameLimiter, GameCheckpointLimiter
	FeedbackLimiter = newBucket(oldFeedback.rate, oldFeedback.capacity)
	PerUserLimiter = newBucket(oldUser.rate, oldUser.capacity)
	IPLimiter = newBucket(oldIP.rate, oldIP.capacity)
	GameLimiter = newBucket(oldGame.rate, oldGame.capacity)
	GameCheckpointLimiter = newBucket(oldCheckpoint.rate, oldCheckpoint.capacity)
	t.Cleanup(func() {
		FeedbackLimiter, PerUserLimiter, IPLimiter = oldFeedback, oldUser, oldIP
		GameLimiter, GameCheckpointLimiter = oldGame, oldCheckpoint
	})
	if FeedbackLimiter.rate != 3.0/60.0 || FeedbackLimiter.capacity != 3 {
		t.Fatalf("unexpected feedback limit: rate=%v capacity=%v", FeedbackLimiter.rate, FeedbackLimiter.capacity)
	}
	r := gin.New()
	r.Use(func(c *gin.Context) {
		id := int64(1)
		if c.GetHeader("X-Test-User") == "other" {
			id = 2
		}
		c.Set(ContextUserKey, &model.User{ID: id, Status: 1})
	})
	finish := func(c *gin.Context) { c.Status(http.StatusNoContent) }
	r.POST("/feedback", RateLimitFeedback(), finish)
	r.POST("/reward", RateLimitUser(), finish)
	r.POST("/game", RateLimitGame(), finish)
	r.POST("/checkpoint", RateLimitGameCheckpoint(), finish)
	r.POST("/oauth", RateLimitIP(), finish)
	request := func(path, user string) int {
		req := httptest.NewRequest(http.MethodPost, path, nil)
		req.Header.Set("X-Test-User", user)
		rec := httptest.NewRecorder()
		r.ServeHTTP(rec, req)
		return rec.Code
	}
	for i := 0; i < 3; i++ {
		if code := request("/feedback", ""); code != http.StatusNoContent {
			t.Fatalf("feedback request %d = %d", i+1, code)
		}
	}
	if code := request("/feedback", ""); code != http.StatusTooManyRequests {
		t.Fatalf("fourth feedback request = %d, want 429", code)
	}
	if code := request("/feedback", "other"); code != http.StatusNoContent {
		t.Fatalf("a different user's feedback capacity was consumed: %d", code)
	}
	for _, test := range []struct {
		path     string
		capacity int
	}{{"/reward", 10}, {"/game", 20}, {"/checkpoint", 60}, {"/oauth", 20}} {
		for i := 0; i < test.capacity; i++ {
			if code := request(test.path, ""); code != http.StatusNoContent {
				t.Fatalf("%s request %d = %d: feedback affected an unrelated bucket", test.path, i+1, code)
			}
		}
	}
	// Advance just this key's refill reference instead of sleeping in a test.
	FeedbackLimiter.mu.Lock()
	FeedbackLimiter.lastSeen["u1"] = time.Now().Add(-21 * time.Second)
	FeedbackLimiter.mu.Unlock()
	if code := request("/feedback", ""); code != http.StatusNoContent {
		t.Fatalf("a refilled feedback token was rejected: %d", code)
	}
}

func TestFeedbackLimiterSweeperRegistration(t *testing.T) {
	now := time.Now()
	key := "feedback-sweeper-test"
	FeedbackLimiter.Allow(key)
	FeedbackLimiter.mu.Lock()
	FeedbackLimiter.lastSeen[key] = now.Add(-2 * time.Hour)
	FeedbackLimiter.mu.Unlock()
	sweepLimiters(now)
	FeedbackLimiter.mu.Lock()
	defer FeedbackLimiter.mu.Unlock()
	if _, ok := FeedbackLimiter.tokens[key]; ok {
		t.Fatal("registered sweeper must remove feedback tokens")
	}
	if _, ok := FeedbackLimiter.lastSeen[key]; ok {
		t.Fatal("registered sweeper must remove feedback lastSeen")
	}
}
