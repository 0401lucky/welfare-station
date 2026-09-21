package middleware

import (
	"context"
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

// sweep 删除 lastSeen 早于 now-maxIdle 的 key,返回删除数量。
//
// 桶是进程内 map,每个新用户 / 新 IP 都会留下一条记录且从不回收,长跑之后就是
// 一处慢泄漏。闲置超过 maxIdle 的 key 令牌早已回满,删掉再出现时按新 key 拿满额,
// 语义上等价。tokens 与 lastSeen 必须一起删,只删一边照样泄漏。
func (b *bucket) sweep(now time.Time, maxIdle time.Duration) int {
	b.mu.Lock()
	defer b.mu.Unlock()
	cutoff := now.Add(-maxIdle)
	removed := 0
	for key, seen := range b.lastSeen {
		if seen.Before(cutoff) {
			delete(b.lastSeen, key)
			delete(b.tokens, key)
			removed++
		}
	}
	return removed
}

const (
	sweepInterval = 10 * time.Minute
	sweepMaxIdle  = time.Hour
)

// StartSweeper 每 10 分钟清理一次全部限流桶里闲置超过 1 小时的 key,阻塞直到 ctx 结束。
// 由 main.go 作为后台 worker 启动,随进程退出信号一起停止。
func StartSweeper(ctx context.Context) {
	ticker := time.NewTicker(sweepInterval)
	defer ticker.Stop()
	buckets := []*bucket{PerUserLimiter, IPLimiter, GameLimiter, GameCheckpointLimiter}
	for {
		select {
		case <-ctx.Done():
			return
		case now := <-ticker.C:
			for _, b := range buckets {
				b.sweep(now, sweepMaxIdle)
			}
		}
	}
}

// PerUserLimiter limits calls per authenticated user (design.md §9: 10/min for
// checkin & claim endpoints).
var PerUserLimiter = newBucket(10.0/60.0, 10)

// IPLimiter limits calls per client IP (design.md §9: OAuth callback).
var IPLimiter = newBucket(20.0/60.0, 20)

// GameLimiter 限制开局/结算/放弃(每用户 30/min)。
//
// 必须与 PerUserLimiter 分开:后者是 10 令牌、每 6 秒回 1 个的**共享**桶,签到与
// 活动领取都挂在上面。游戏若复用它,玩几局就会把用户的签到额度吃光。
var GameLimiter = newBucket(30.0/60.0, 20)

// GameCheckpointLimiter 单独放宽 checkpoint(每用户 120/min)。
//
// checkpoint 的频率由玩家手速决定,远高于其他接口;且丢一次 checkpoint 无害
// (moves 仍在前端本地,下个周期重传),所以这里给足余量而不是从严。
var GameCheckpointLimiter = newBucket(120.0/60.0, 60)

// rateLimitBy 按给定的桶做每用户限流,是下面三个包装函数的共同实现。
func rateLimitBy(b *bucket) gin.HandlerFunc {
	return func(c *gin.Context) {
		key := c.GetString("rate_limit_key")
		if key == "" {
			if u := CurrentUser(c); u != nil {
				key = "u" + int64ToStr(u.ID)
			} else {
				key = "anon" + c.ClientIP()
			}
		}
		if !b.Allow(key) {
			common.Fail(c, http.StatusTooManyRequests, "请求过于频繁,请稍后再试")
			c.Abort()
			return
		}
		c.Next()
	}
}

// RateLimitGame 用于开局/结算/放弃。
func RateLimitGame() gin.HandlerFunc { return rateLimitBy(GameLimiter) }

// RateLimitGameCheckpoint 用于中途存档,额度比 RateLimitGame 宽得多。
func RateLimitGameCheckpoint() gin.HandlerFunc { return rateLimitBy(GameCheckpointLimiter) }

// RateLimitUser wraps a route with a per-user token bucket.
func RateLimitUser() gin.HandlerFunc { return rateLimitBy(PerUserLimiter) }

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
