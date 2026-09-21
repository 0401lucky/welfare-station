package middleware

import (
	"fmt"
	"testing"
	"time"
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
