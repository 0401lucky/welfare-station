package service

import (
	"strings"
	"testing"
)

// TestSiteNoticeRoundTrip 验证公告保存会去首尾空白、按字符数限长,空白即清空。
func TestSiteNoticeRoundTrip(t *testing.T) {
	db := grantDB(t)
	if got := GetSiteNotice(db); got != "" {
		t.Fatalf("初始公告应为空, got %q", got)
	}

	saved, err := PutSiteNotice(db, "  今晚加倍 🍀 \n")
	if err != nil || saved != "今晚加倍 🍀" {
		t.Fatalf("saved = %q, err = %v", saved, err)
	}
	if got := GetSiteNotice(db); got != saved {
		t.Fatalf("读回 = %q, want %q", got, saved)
	}

	// 500 字恰好可存,501 字拒绝且不覆盖已有公告;按字符数而非字节数。
	limit := strings.Repeat("字", 500)
	if _, err := PutSiteNotice(db, limit); err != nil {
		t.Fatalf("500 字应可保存: %v", err)
	}
	if _, err := PutSiteNotice(db, limit+"多"); err == nil {
		t.Fatal("501 字应被拒绝")
	}
	if got := GetSiteNotice(db); got != limit {
		t.Fatal("超长提交不应覆盖已有公告")
	}

	if saved, err := PutSiteNotice(db, "   "); err != nil || saved != "" {
		t.Fatalf("空白应清空公告, saved = %q, err = %v", saved, err)
	}
	if got := GetSiteNotice(db); got != "" {
		t.Fatalf("清空后读回 = %q", got)
	}
}
