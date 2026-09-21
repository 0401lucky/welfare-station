package service

import (
	"encoding/json"
	"strings"
	"testing"
	"unicode/utf8"

	"welfare/model"
)

// TestRecordAuditWritesRow 验证审计行字段完整、detail 序列化为 JSON、actor 为空时记 0。
func TestRecordAuditWritesRow(t *testing.T) {
	db := grantDB(t)
	actor := &model.User{LinuxDOID: "a", LinuxDOName: "boss", Status: 1, IsAdmin: true}
	if err := db.Create(actor).Error; err != nil {
		t.Fatalf("create actor: %v", err)
	}

	RecordAudit(db, actor, AuditBanUser, AuditTargetUser, 42, map[string]any{"status": 2}, "203.0.113.9")
	RecordAudit(db, nil, AuditPutSiteNotice, AuditTargetSetting, 0, nil, "")

	var rows []model.AdminLog
	if err := db.Order("id asc").Find(&rows).Error; err != nil {
		t.Fatalf("find: %v", err)
	}
	if len(rows) != 2 {
		t.Fatalf("rows = %d, want 2", len(rows))
	}
	first := rows[0]
	if first.AdminUserID != actor.ID || first.Action != AuditBanUser || first.TargetType != AuditTargetUser || first.TargetID != 42 || first.IP != "203.0.113.9" {
		t.Fatalf("first row = %+v", first)
	}
	var detail map[string]any
	if err := json.Unmarshal([]byte(first.Detail), &detail); err != nil || detail["status"] != float64(2) {
		t.Fatalf("detail 应为 JSON: %q err=%v", first.Detail, err)
	}
	if first.CreatedAt.IsZero() {
		t.Fatal("created_at 应有值")
	}
	if second := rows[1]; second.AdminUserID != 0 || second.Detail != "" {
		t.Fatalf("空 actor / 空 detail 应写 0 与空串: %+v", second)
	}
}

// TestRecordAuditTruncatesDetail 验证超长 detail 按字符数截断到 2000,不切断多字节字符。
func TestRecordAuditTruncatesDetail(t *testing.T) {
	db := grantDB(t)
	long := strings.Repeat("长", 3000)
	RecordAudit(db, nil, AuditPutSiteNotice, AuditTargetSetting, 0, AuditDiff{Before: "", After: long}, "")

	var row model.AdminLog
	if err := db.First(&row).Error; err != nil {
		t.Fatalf("first: %v", err)
	}
	if n := utf8.RuneCountInString(row.Detail); n != auditDetailMaxRunes {
		t.Fatalf("detail 长度 = %d 字, want %d", n, auditDetailMaxRunes)
	}
	if !utf8.ValidString(row.Detail) {
		t.Fatal("截断后必须仍是合法 UTF-8")
	}
	if !strings.HasPrefix(row.Detail, `{"before":"","after":"长`) {
		t.Fatalf("截断应保留开头: %q", row.Detail[:40])
	}
}

// TestIsAuditAction 验证动作清单包含全部常量且拒绝未知值。
func TestIsAuditAction(t *testing.T) {
	for _, a := range AuditActions {
		if !IsAuditAction(a) {
			t.Errorf("%s 应被识别", a)
		}
	}
	if IsAuditAction("drop_table") || IsAuditAction("") {
		t.Error("未知动作不应被识别")
	}
}
