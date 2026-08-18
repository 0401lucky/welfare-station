package middleware

import (
	"net/http"
	"strconv"
	"sync"
	"time"

	"welfare/common"

	"github.com/gin-gonic/gin"
)

// bucket is a tiny in-memory token bucket used for per-key rate limiting.
type bucket struct {
	mu       sync.Mutex
	tokens   map[string]float64
	lastSeen map[string]time.Time
	rate     float64 // tokens refilled per second
	capacity float64 // burst capacity
}

func newBucket(rate float64, capacity float64) *bucket {
	return &bucket{
		tokens:   make(map[string]float64),
		lastSeen: make(map[string]time.Time),
		rate:     rate,
		capacity: capacity,
	}
}

func (b *bucket) Allow(key string) bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	now := time.Now()
	last, ok := b.lastSeen[key]
	if !ok {
		b.tokens[key] = b.capacity
	} else {
		b.tokens[key] += now.Sub(last).Seconds() * b.rate
		if b.tokens[key] > b.capacity {
			b.tokens[key] = b.capacity
		}
	}
	b.lastSeen[key] = now
	if b.tokens[key] < 1 {
		return false
	}
	b.tokens[key]--
	return true
}

// PerUserLimiter limits calls per authenticated user (design.md §9: 10/min for
// checkin & claim endpoints).
var PerUserLimiter = newBucket(10.0/60.0, 10)

// IPLimiter limits calls per client IP (design.md §9: OAuth callback).
var IPLimiter = newBucket(20.0/60.0, 20)

// RateLimitUser wraps a route with a per-user token bucket.
func RateLimitUser() gin.HandlerFunc {
	return func(c *gin.Context) {
		key := c.GetString("rate_limit_key")
		if key == "" {
			if u := CurrentUser(c); u != nil {
				key = "u" + int64ToStr(u.ID)
			} else {
				key = "anon" + c.ClientIP()
			}
		}
		if !PerUserLimiter.Allow(key) {
			common.Fail(c, http.StatusTooManyRequests, "请求过于频繁,请稍后再试")
			c.Abort()
			return
		}
		c.Next()
	}
}

// RateLimitIP wraps a route with a per-IP token bucket.
func RateLimitIP() gin.HandlerFunc {
	return func(c *gin.Context) {
		if !IPLimiter.Allow(c.ClientIP()) {
			common.Fail(c, http.StatusTooManyRequests, "请求过于频繁,请稍后再试")
			c.Abort()
			return
		}
		c.Next()
	}
}

func int64ToStr(i int64) string {
	return strconv.FormatInt(i, 10)
}
