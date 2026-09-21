package controller

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"testing"
	"time"

	"welfare/model"
	"welfare/service"
)

func auditRows(t *testing.T, app *App, action string) []model.AdminLog {
	t.Helper()
	var rows []model.AdminLog
	q := app.DB.Order("id asc")
	if action != "" {
		q = q.Where("action = ?", action)
	}
	if err := q.Find(&rows).Error; err != nil {
		t.Fatalf("load audit rows: %v", err)
	}
	return rows
}

// TestAdminWritesProduceAuditLogs 验证所有后台写操作都会留下审计行,并且日志接口
// 可按动作 / 操作者筛选分页、带出操作者投影、拒绝未知动作。
func TestAdminWritesProduceAuditLogs(t *testing.T) {
	app, srv, _ := checkinTestApp(t)
	defer srv.Close()
	admin, normal := adminUsers(t, app)
	cookie := sessionCookie(t, app, admin.ID)
	r := adminRoutes(app)

	// 1. 手动发放(成功)。
	rec := performJSON(r, http.MethodPost, "/api/admin/grants/manual", `{"newapi_user_id":42,"quota":777,"remark":"补偿"}`, cookie)
	if rec.Code != http.StatusOK {
		t.Fatalf("manual grant: %d %s", rec.Code, rec.Body.String())
	}
	var manual struct {
		Data model.Grant `json:"data"`
	}
	json.Unmarshal(rec.Body.Bytes(), &manual)
	rows := auditRows(t, app, service.AuditManualGrant)
	if len(rows) != 1 || rows[0].AdminUserID != admin.ID || rows[0].TargetType != service.AuditTargetGrant || rows[0].TargetID != manual.Data.ID || rows[0].IP == "" {
		t.Fatalf("manual_grant 审计行不对: %+v", rows)
	}
	if !strings.Contains(rows[0].Detail, `"quota":777`) || !strings.Contains(rows[0].Detail, `"remark":"补偿"`) {
		t.Fatalf("manual_grant detail = %s", rows[0].Detail)
	}

	// 2. 重试一条失败流水。
	failed := model.Grant{UserID: admin.ID, NewapiUserID: 900, Type: "manual", RefID: service.NewManualRefID(), Quota: 1000, Status: service.GrantStatusFailed}
	app.DB.Create(&failed)
	if rec = perform(r, http.MethodPost, fmt.Sprintf("/api/admin/grants/%d/retry", failed.ID), []*http.Cookie{cookie}); rec.Code != http.StatusOK {
		t.Fatalf("retry: %d %s", rec.Code, rec.Body.String())
	}
	if rows = auditRows(t, app, service.AuditRetryGrant); len(rows) != 1 || rows[0].TargetID != failed.ID || !strings.Contains(rows[0].Detail, `"status":"success"`) {
		t.Fatalf("retry_grant 审计行不对: %+v", rows)
	}
	// 不可重试的流水不产生日志。
	if rec = perform(r, http.MethodPost, fmt.Sprintf("/api/admin/grants/%d/retry", failed.ID), []*http.Cookie{cookie}); rec.Code != http.StatusBadRequest {
		t.Fatalf("second retry should 400: %d", rec.Code)
	}
	if rows = auditRows(t, app, service.AuditRetryGrant); len(rows) != 1 {
		t.Fatalf("被拒的重试不应记日志: %d", len(rows))
	}

	// 3. 封禁 / 解封。
	performJSON(r, http.MethodPut, fmt.Sprintf("/api/admin/users/%d/status", normal.ID), `{"status":2}`, cookie)
	performJSON(r, http.MethodPut, fmt.Sprintf("/api/admin/users/%d/status", normal.ID), `{"status":1}`, cookie)
	if rows = auditRows(t, app, service.AuditBanUser); len(rows) != 1 || rows[0].TargetID != normal.ID || rows[0].TargetType != service.AuditTargetUser {
		t.Fatalf("ban_user 审计行不对: %+v", rows)
	}
	if rows = auditRows(t, app, service.AuditUnbanUser); len(rows) != 1 {
		t.Fatalf("unban_user 审计行不对: %+v", rows)
	}

	// 4. 活动新建 / 编辑 / 删除。
	start := time.Now().Add(-time.Hour).UTC().Format(time.RFC3339)
	end := time.Now().Add(24 * time.Hour).UTC().Format(time.RFC3339)
	rec = performJSON(r, http.MethodPost, "/api/admin/activities", fmt.Sprintf(`{"title":"审计活动","quota":500,"total_count":10,"start_at":%q,"end_at":%q,"status":1}`, start, end), cookie)
	if rec.Code != http.StatusOK {
		t.Fatalf("create activity: %d %s", rec.Code, rec.Body.String())
	}
	var created struct {
		Data model.Activity `json:"data"`
	}
	json.Unmarshal(rec.Body.Bytes(), &created)
	aid := created.Data.ID
	performJSON(r, http.MethodPut, fmt.Sprintf("/api/admin/activities/%d", aid), fmt.Sprintf(`{"title":"审计活动改","quota":500,"total_count":10,"per_user_limit":1,"min_trust_level":0,"start_at":%q,"end_at":%q,"status":2}`, start, end), cookie)
	perform(r, http.MethodDelete, fmt.Sprintf("/api/admin/activities/%d", aid), []*http.Cookie{cookie})
	if rows = auditRows(t, app, service.AuditCreateActivity); len(rows) != 1 || rows[0].TargetID != aid {
		t.Fatalf("create_activity 审计行不对: %+v", rows)
	}
	if rows = auditRows(t, app, service.AuditUpdateActivity); len(rows) != 1 || !strings.Contains(rows[0].Detail, `"before"`) || !strings.Contains(rows[0].Detail, `审计活动改`) {
		t.Fatalf("update_activity 应带 before/after: %+v", rows)
	}
	// before 必须是改动前的快照:gorm Updates 会把新值写回 model,快照若取晚了就会与 after 相同。
	if !strings.Contains(rows[0].Detail, `"title":"审计活动","`) || !strings.Contains(rows[0].Detail, `"status":1`) {
		t.Fatalf("update_activity 的 before 应保留旧标题与旧状态: %s", rows[0].Detail)
	}
	if rows = auditRows(t, app, service.AuditDeleteActivity); len(rows) != 1 || !strings.Contains(rows[0].Detail, `审计活动改`) {
		t.Fatalf("delete_activity 应存删除前快照: %+v", rows)
	}
	// 删除不存在的活动:保持幂等返回,但不记日志。
	perform(r, http.MethodDelete, "/api/admin/activities/999999", []*http.Cookie{cookie})
	if rows = auditRows(t, app, service.AuditDeleteActivity); len(rows) != 1 {
		t.Fatalf("删除不存在的活动不应记日志: %d", len(rows))
	}

	// 5. 五类配置写入,detail 带 before/after。
	performJSON(r, http.MethodPut, "/api/admin/checkin-config", `{"enabled":true,"timezone":"Asia/Shanghai","mode":"fixed","fixed_quota":12345,"min_quota":0,"max_quota":0,"streak_bonuses":[],"min_trust_level":0}`, cookie)
	performJSON(r, http.MethodPut, "/api/admin/game-config", gameConfigJSON(`{"tile":512,"quota":10000}`, `"total":{"enabled":false,"daily":0},"game":{"enabled":true,"daily":10000000},"checkin":{"enabled":false,"daily":0},"activity":{"enabled":false,"daily":0}`), cookie)
	performJSON(r, http.MethodPut, "/api/admin/draw-config", `{"enabled":true,"timezone":"Asia/Shanghai","tiers":[{"label":"全","quip":"","roll_min":1,"roll_max":100,"reward_type":"temporary","min_quota":0,"max_quota":0,"daily_winner_limit":0}]}`, cookie)
	performJSON(r, http.MethodPut, "/api/admin/grant-config", `{"max_grant_quota":4000000}`, cookie)
	performJSON(r, http.MethodPut, "/api/admin/site-notice", `{"notice":"审计公告"}`, cookie)
	for _, action := range []string{service.AuditPutCheckinConfig, service.AuditPutGameConfig, service.AuditPutDrawConfig, service.AuditPutGrantConfig, service.AuditPutSiteNotice} {
		rows = auditRows(t, app, action)
		if len(rows) != 1 {
			t.Fatalf("%s 应恰好一行, got %d", action, len(rows))
		}
		if rows[0].TargetType != service.AuditTargetSetting || !strings.Contains(rows[0].Detail, `"before"`) || !strings.Contains(rows[0].Detail, `"after"`) {
			t.Fatalf("%s 应带 before/after: %+v", action, rows[0])
		}
	}
	if rows = auditRows(t, app, service.AuditPutSiteNotice); !strings.Contains(rows[0].Detail, `"after":"审计公告"`) {
		t.Fatalf("公告 detail = %s", rows[0].Detail)
	}
	// 校验失败不写日志。
	performJSON(r, http.MethodPut, "/api/admin/grant-config", `{"max_grant_quota":0}`, cookie)
	if rows = auditRows(t, app, service.AuditPutGrantConfig); len(rows) != 1 {
		t.Fatalf("校验失败不应记日志: %d", len(rows))
	}

	// 6. 日志接口:总数、分页、筛选、操作者投影、未知动作。
	all := auditRows(t, app, "")
	type logPage struct {
		Data struct {
			Total    int64          `json:"total"`
			Page     int            `json:"page"`
			PageSize int            `json:"page_size"`
			Items    []AdminLogItem `json:"items"`
		} `json:"data"`
	}
	list := func(t *testing.T, query string) logPage {
		t.Helper()
		rec := perform(r, http.MethodGet, "/api/admin/logs?"+query, []*http.Cookie{cookie})
		if rec.Code != http.StatusOK {
			t.Fatalf("logs %q: %d %s", query, rec.Code, rec.Body.String())
		}
		var resp logPage
		if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
			t.Fatalf("decode logs: %v", err)
		}
		return resp
	}
	first := list(t, "page_size=5")
	if first.Data.Total != int64(len(all)) || len(first.Data.Items) != 5 || first.Data.Items[0].ID != all[len(all)-1].ID {
		t.Fatalf("日志应倒序分页: total=%d items=%d first=%d wantFirst=%d", first.Data.Total, len(first.Data.Items), first.Data.Items[0].ID, all[len(all)-1].ID)
	}
	if first.Data.Items[0].Admin == nil || first.Data.Items[0].Admin.LinuxDOName != "boss" {
		t.Fatalf("应带出操作者投影: %+v", first.Data.Items[0].Admin)
	}
	if byAction := list(t, "action="+service.AuditBanUser); byAction.Data.Total != 1 || byAction.Data.Items[0].TargetID != normal.ID {
		t.Fatalf("按动作筛选: %+v", byAction.Data)
	}
	if byAdmin := list(t, fmt.Sprintf("admin_id=%d", admin.ID)); byAdmin.Data.Total != int64(len(all)) {
		t.Fatalf("按操作者筛选应等于全部: %d", byAdmin.Data.Total)
	}
	if other := list(t, fmt.Sprintf("admin_id=%d", normal.ID)); other.Data.Total != 0 {
		t.Fatalf("普通用户没有操作: %d", other.Data.Total)
	}
	for _, bad := range []string{"action=drop_table", "admin_id=abc", "admin_id=0"} {
		if rec := perform(r, http.MethodGet, "/api/admin/logs?"+bad, []*http.Cookie{cookie}); rec.Code != http.StatusBadRequest {
			t.Errorf("%s 应 400, got %d", bad, rec.Code)
		}
	}
}

// TestAdminDashboardTrendEndpoint 验证趋势接口的天数解析与响应形状;聚合口径由 service 测试覆盖。
func TestAdminDashboardTrendEndpoint(t *testing.T) {
	app, srv, _ := checkinTestApp(t)
	defer srv.Close()
	admin, _ := adminUsers(t, app)
	cookie := sessionCookie(t, app, admin.ID)
	today := service.TodayStr(service.DefaultTimezone, time.Now())
	app.DB.Create(&model.Checkin{UserID: admin.ID, CheckinDate: today, Quota: 1, Streak: 1})

	var resp struct {
		Data struct {
			Timezone string             `json:"timezone"`
			Days     []service.TrendDay `json:"days"`
		} `json:"data"`
	}
	for _, tc := range []struct {
		query string
		want  int
	}{{"", 7}, {"?days=3", 3}, {"?days=abc", 7}, {"?days=0", 7}, {"?days=100", 30}} {
		rec := perform(adminRoutes(app), http.MethodGet, "/api/admin/dashboard/trend"+tc.query, []*http.Cookie{cookie})
		if rec.Code != http.StatusOK {
			t.Fatalf("trend%s: %d %s", tc.query, rec.Code, rec.Body.String())
		}
		resp.Data.Days = nil
		if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
			t.Fatalf("decode: %v", err)
		}
		if len(resp.Data.Days) != tc.want {
			t.Fatalf("trend%s 应 %d 天, got %d", tc.query, tc.want, len(resp.Data.Days))
		}
		if last := resp.Data.Days[len(resp.Data.Days)-1]; last.Date != today || last.Checkins != 1 {
			t.Fatalf("最后一项应为今日且含 1 次签到: %+v", last)
		}
	}
	if resp.Data.Timezone != service.DefaultTimezone {
		t.Fatalf("timezone = %q", resp.Data.Timezone)
	}
}

// TestAdminUserDetailAndNote 验证用户详情统计、最近 20 条流水、备注往返与审计。
func TestAdminUserDetailAndNote(t *testing.T) {
	app, srv, _ := checkinTestApp(t)
	defer srv.Close()
	admin, alice := adminUsers(t, app)
	cookie := sessionCookie(t, app, admin.ID)
	r := adminRoutes(app)

	today := service.TodayStr(service.DefaultTimezone, time.Now())
	yesterday := service.TodayStr(service.DefaultTimezone, time.Now().AddDate(0, 0, -1))
	for i, c := range []model.Checkin{
		{UserID: alice.ID, CheckinDate: "2026-01-01", Quota: 1, Streak: 1},
		{UserID: alice.ID, CheckinDate: yesterday, Quota: 1, Streak: 1},
		{UserID: alice.ID, CheckinDate: today, Quota: 1, Streak: 2},
	} {
		if err := app.DB.Create(&c).Error; err != nil {
			t.Fatalf("checkin %d: %v", i, err)
		}
	}
	for i := 0; i < 25; i++ {
		g := model.Grant{UserID: alice.ID, NewapiUserID: 42, Type: "manual", RefID: service.NewManualRefID(), Quota: int64(i + 1), Status: service.GrantStatusSuccess}
		if err := app.DB.Create(&g).Error; err != nil {
			t.Fatalf("grant %d: %v", i, err)
		}
	}
	for i, p := range []model.GamePlay{
		{UserID: alice.ID, GameType: "2048", SessionID: "d1", PlayDate: today, Quota: 300, Reason: "ok"},
		{UserID: alice.ID, GameType: "2048", SessionID: "d2", PlayDate: today, Quota: 0, Reason: "below_tier"},
		{UserID: admin.ID, GameType: "2048", SessionID: "d3", PlayDate: today, Quota: 9999, Reason: "ok"},
	} {
		if err := app.DB.Create(&p).Error; err != nil {
			t.Fatalf("play %d: %v", i, err)
		}
	}

	type detail struct {
		Data struct {
			User         model.User    `json:"user"`
			RecentGrants []model.Grant `json:"recent_grants"`
			Checkin      struct {
				TotalDays int64 `json:"total_days"`
				Streak    int   `json:"streak"`
			} `json:"checkin"`
			Game struct {
				Plays int64 `json:"plays"`
				Quota int64 `json:"quota"`
			} `json:"game"`
		} `json:"data"`
	}
	get := func(t *testing.T) detail {
		t.Helper()
		rec := perform(r, http.MethodGet, fmt.Sprintf("/api/admin/users/%d", alice.ID), []*http.Cookie{cookie})
		if rec.Code != http.StatusOK {
			t.Fatalf("detail: %d %s", rec.Code, rec.Body.String())
		}
		var resp detail
		if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
			t.Fatalf("decode: %v", err)
		}
		return resp
	}
	d := get(t)
	if d.Data.User.ID != alice.ID || d.Data.User.Note != "" {
		t.Fatalf("user = %+v", d.Data.User)
	}
	if len(d.Data.RecentGrants) != 20 || d.Data.RecentGrants[0].Quota != 25 || d.Data.RecentGrants[19].Quota != 6 {
		t.Fatalf("最近流水应为最新 20 条: len=%d first=%d last=%d", len(d.Data.RecentGrants), d.Data.RecentGrants[0].Quota, d.Data.RecentGrants[len(d.Data.RecentGrants)-1].Quota)
	}
	if d.Data.Checkin.TotalDays != 3 || d.Data.Checkin.Streak != 2 {
		t.Fatalf("签到统计 = %+v", d.Data.Checkin)
	}
	if d.Data.Game.Plays != 2 || d.Data.Game.Quota != 300 {
		t.Fatalf("游戏统计 = %+v(不应混入别人的对局)", d.Data.Game)
	}

	rec := performJSON(r, http.MethodPut, fmt.Sprintf("/api/admin/users/%d/note", alice.ID), `{"note":"  VIP 客户 🍀  "}`, cookie)
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"note":"VIP 客户 🍀"`) {
		t.Fatalf("put note: %d %s", rec.Code, rec.Body.String())
	}
	if got := get(t).Data.User.Note; got != "VIP 客户 🍀" {
		t.Fatalf("note 读回 = %q", got)
	}
	rows := auditRows(t, app, service.AuditPutUserNote)
	if len(rows) != 1 || rows[0].TargetID != alice.ID || !strings.Contains(rows[0].Detail, `"before":""`) || !strings.Contains(rows[0].Detail, `"after":"VIP 客户 🍀"`) {
		t.Fatalf("put_user_note 审计行不对: %+v", rows)
	}

	rec = performJSON(r, http.MethodPut, fmt.Sprintf("/api/admin/users/%d/note", alice.ID), `{"note":"`+strings.Repeat("字", 501)+`"}`, cookie)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("501 字应 400, got %d", rec.Code)
	}
	if got := get(t).Data.User.Note; got != "VIP 客户 🍀" {
		t.Fatal("超长备注不应覆盖已有备注")
	}
	if rec = performJSON(r, http.MethodPut, "/api/admin/users/999999/note", `{"note":"x"}`, cookie); rec.Code != http.StatusNotFound {
		t.Fatalf("不存在的用户应 404, got %d", rec.Code)
	}
	if rec = perform(r, http.MethodGet, "/api/admin/users/999999", []*http.Cookie{cookie}); rec.Code != http.StatusNotFound {
		t.Fatalf("不存在的用户详情应 404, got %d", rec.Code)
	}
	// 清空备注也是合法写入。
	if rec = performJSON(r, http.MethodPut, fmt.Sprintf("/api/admin/users/%d/note", alice.ID), `{"note":"   "}`, cookie); rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"note":""`) {
		t.Fatalf("clear note: %d %s", rec.Code, rec.Body.String())
	}
}
