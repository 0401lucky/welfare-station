package controller

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"testing"

	"welfare/model"
	"welfare/service"
)

// TestAdminSiteNoticeRoundTrip 验证公告 GET/PUT 往返、/site/info 透出与超长拒绝。
func TestAdminSiteNoticeRoundTrip(t *testing.T) {
	app, srv, _ := checkinTestApp(t)
	defer srv.Close()
	admin, _ := adminUsers(t, app)
	cookie := sessionCookie(t, app, admin.ID)
	r := adminRoutes(app)
	r.GET("/api/site/info", app.SiteInfo)

	readNotice := func(t *testing.T, path string) string {
		t.Helper()
		rec := perform(r, http.MethodGet, path, []*http.Cookie{cookie})
		if rec.Code != http.StatusOK {
			t.Fatalf("GET %s: %d %s", path, rec.Code, rec.Body.String())
		}
		var resp struct {
			Data struct {
				Notice string `json:"notice"`
			} `json:"data"`
		}
		if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
			t.Fatalf("decode %s: %v", path, err)
		}
		return resp.Data.Notice
	}

	if got := readNotice(t, "/api/admin/site-notice"); got != "" {
		t.Fatalf("初始公告应为空, got %q", got)
	}
	rec := performJSON(r, http.MethodPut, "/api/admin/site-notice", `{"notice":"  今晚翻牌加倍  "}`, cookie)
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"notice":"今晚翻牌加倍"`) {
		t.Fatalf("put notice: %d %s", rec.Code, rec.Body.String())
	}
	if got := readNotice(t, "/api/admin/site-notice"); got != "今晚翻牌加倍" {
		t.Fatalf("后台读回 = %q", got)
	}
	if got := readNotice(t, "/api/site/info"); got != "今晚翻牌加倍" {
		t.Fatalf("/site/info 应透出公告, got %q", got)
	}

	rec = performJSON(r, http.MethodPut, "/api/admin/site-notice", `{"notice":"`+strings.Repeat("字", 501)+`"}`, cookie)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("501 字应 400, got %d %s", rec.Code, rec.Body.String())
	}
	if got := readNotice(t, "/api/site/info"); got != "今晚翻牌加倍" {
		t.Fatal("超长提交不应覆盖已有公告")
	}

	rec = performJSON(r, http.MethodPut, "/api/admin/site-notice", `{"notice":""}`, cookie)
	if rec.Code != http.StatusOK {
		t.Fatalf("clear notice: %d %s", rec.Code, rec.Body.String())
	}
	if got := readNotice(t, "/api/site/info"); got != "" {
		t.Fatalf("清空后 /site/info 应为空, got %q", got)
	}
}

type adminUserPage struct {
	Total    int64        `json:"total"`
	Page     int          `json:"page"`
	PageSize int          `json:"page_size"`
	Items    []model.User `json:"items"`
}

func listUsers(t *testing.T, app *App, cookie *http.Cookie, query string) adminUserPage {
	t.Helper()
	rec := perform(adminRoutes(app), http.MethodGet, "/api/admin/users?"+query, []*http.Cookie{cookie})
	if rec.Code != http.StatusOK {
		t.Fatalf("list users %q: %d %s", query, rec.Code, rec.Body.String())
	}
	var resp struct {
		Data adminUserPage `json:"data"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode users %q: %v", query, err)
	}
	return resp.Data
}

// TestAdminListUsersPagination 验证用户列表分页与筛选:150 人可翻页看全,
// bound / status / keyword 组合正确,非法筛选值 400,通配符按字面量匹配。
func TestAdminListUsersPagination(t *testing.T) {
	app, srv, _ := checkinTestApp(t)
	defer srv.Close()
	admin, _ := adminUsers(t, app) // 已有 boss(已绑定)与 alice(已绑定),共 2 人
	cookie := sessionCookie(t, app, admin.ID)

	// 再造 148 人:偶数号已绑定,每 10 号一个封禁。
	for i := 0; i < 148; i++ {
		u := model.User{LinuxDOID: fmt.Sprintf("2%05d", i), LinuxDOName: fmt.Sprintf("bulk_%03d", i), Status: 1}
		if i%2 == 0 {
			u.NewapiUserID = int64p(int64(1000 + i))
			u.NewapiUsername = fmt.Sprintf("api_%03d", i)
		}
		if i%10 == 0 {
			u.Status = 2
		}
		if err := app.DB.Create(&u).Error; err != nil {
			t.Fatalf("create bulk user %d: %v", i, err)
		}
	}
	const total = 150

	first := listUsers(t, app, cookie, "")
	if first.Total != total || first.Page != 1 || first.PageSize != 20 || len(first.Items) != 20 {
		t.Fatalf("默认分页: %+v", first)
	}
	last := listUsers(t, app, cookie, "page=8&page_size=20")
	if last.Total != total || last.Page != 8 || len(last.Items) != 10 {
		t.Fatalf("最后一页应有 10 人: total=%d page=%d items=%d", last.Total, last.Page, len(last.Items))
	}
	if beyond := listUsers(t, app, cookie, "page=9"); beyond.Total != total || len(beyond.Items) != 0 {
		t.Fatalf("越界页应为空且 total 不变: %+v", beyond)
	}
	if big := listUsers(t, app, cookie, "page_size=100"); big.PageSize != 100 || len(big.Items) != 100 {
		t.Fatalf("page_size=100 应生效: page_size=%d items=%d", big.PageSize, len(big.Items))
	}
	if capped := listUsers(t, app, cookie, "page_size=101"); capped.PageSize != 20 {
		t.Fatalf("page_size 超上限应回落 20, got %d", capped.PageSize)
	}

	// 已绑定 = boss + alice + 74 个偶数号 = 76;未绑定 = 74。
	if bound := listUsers(t, app, cookie, "bound=yes"); bound.Total != 76 {
		t.Fatalf("bound=yes total = %d, want 76", bound.Total)
	}
	if unbound := listUsers(t, app, cookie, "bound=no"); unbound.Total != 74 {
		t.Fatalf("bound=no total = %d, want 74", unbound.Total)
	}
	// 封禁 = 0,10,...,140 共 15 人。
	if banned := listUsers(t, app, cookie, "status=2"); banned.Total != 15 {
		t.Fatalf("status=2 total = %d, want 15", banned.Total)
	}
	// 组合:封禁且已绑定 = 15 个封禁号全是偶数 → 15;封禁且未绑定 = 0。
	if both := listUsers(t, app, cookie, "status=2&bound=yes"); both.Total != 15 {
		t.Fatalf("status=2&bound=yes total = %d, want 15", both.Total)
	}
	if none := listUsers(t, app, cookie, "status=2&bound=no"); none.Total != 0 {
		t.Fatalf("status=2&bound=no total = %d, want 0", none.Total)
	}
	// 关键词 + 筛选:bulk_00x 共 10 人(000-009),其中已绑定 5 人。
	if kw := listUsers(t, app, cookie, "keyword=bulk_00&bound=yes"); kw.Total != 5 {
		t.Fatalf("keyword+bound total = %d, want 5", kw.Total)
	}
	// LIKE 通配符按字面量:没有名字里带 % 的用户。
	if wild := listUsers(t, app, cookie, "keyword=%25"); wild.Total != 0 {
		t.Fatalf("通配符应按字面量匹配, total = %d", wild.Total)
	}
	// all 与空等价。
	if all := listUsers(t, app, cookie, "bound=all&status=all"); all.Total != total {
		t.Fatalf("bound=all&status=all total = %d", all.Total)
	}

	for _, bad := range []string{"bound=maybe", "status=3"} {
		rec := perform(adminRoutes(app), http.MethodGet, "/api/admin/users?"+bad, []*http.Cookie{cookie})
		if rec.Code != http.StatusBadRequest {
			t.Errorf("%s 应 400, got %d", bad, rec.Code)
		}
	}
}

// TestAdminExportGrantsCSV 验证导出复用列表筛选:BOM、表头、行数与 total 一致、
// 时间按签到时区、额度换算美元,公式注入前缀被转义。
func TestAdminExportGrantsCSV(t *testing.T) {
	app, srv, _ := checkinTestApp(t)
	defer srv.Close()
	admin, alice := adminUsers(t, app)
	cookie := sessionCookie(t, app, admin.ID)

	cfg := service.DefaultCheckinConfig()
	cfg.Timezone = "America/New_York"
	if err := service.SaveCheckinConfig(app.DB, cfg); err != nil {
		t.Fatalf("save checkin config: %v", err)
	}
	evil := model.User{LinuxDOID: "evil", LinuxDOName: "=HYPERLINK(\"x\")", Status: 1, NewapiUserID: int64p(66)}
	if err := app.DB.Create(&evil).Error; err != nil {
		t.Fatalf("create evil user: %v", err)
	}
	grants := []model.Grant{
		{UserID: alice.ID, NewapiUserID: 42, Type: "checkin", RefID: 8001, Quota: 250000, QuotaType: service.QuotaTypePermanent, Status: service.GrantStatusSuccess},
		{UserID: alice.ID, NewapiUserID: 42, Type: "draw", RefID: 8002, Quota: 100, QuotaType: service.QuotaTypeTemporary, Status: service.GrantStatusFailed, Error: "-timeout"},
		{UserID: evil.ID, NewapiUserID: 66, Type: "manual", RefID: 8003, Quota: 500000, QuotaType: service.QuotaTypePermanent, Status: service.GrantStatusSuccess},
	}
	for i := range grants {
		if err := app.DB.Create(&grants[i]).Error; err != nil {
			t.Fatalf("create grant %d: %v", i, err)
		}
	}

	rec := perform(adminRoutes(app), http.MethodGet, "/api/admin/grants/export", []*http.Cookie{cookie})
	if rec.Code != http.StatusOK {
		t.Fatalf("export: %d %s", rec.Code, rec.Body.String())
	}
	if ct := rec.Header().Get("Content-Type"); !strings.HasPrefix(ct, "text/csv") {
		t.Fatalf("Content-Type = %q", ct)
	}
	if cd := rec.Header().Get("Content-Disposition"); !strings.HasPrefix(cd, `attachment; filename="grants-`) || !strings.HasSuffix(cd, `.csv"`) {
		t.Fatalf("Content-Disposition = %q", cd)
	}
	body := rec.Body.String()
	if !strings.HasPrefix(body, "\xEF\xBB\xBF") {
		t.Fatal("缺少 UTF-8 BOM")
	}
	lines := strings.Split(strings.TrimRight(strings.TrimPrefix(body, "\xEF\xBB\xBF"), "\r\n"), "\r\n")
	if len(lines) != 4 {
		t.Fatalf("应为表头 + 3 行, got %d: %q", len(lines), lines)
	}
	if lines[0] != "流水ID,时间,LinuxDO 用户名,new-api 用户ID,类型,额度(美元),额度类型,状态,错误信息" {
		t.Fatalf("表头 = %q", lines[0])
	}
	// id desc:第一行是 evil 的手动发放,用户名以 = 开头须加前导单引号;
	// 字段含引号时 encoding/csv 会整体加引号并把内部引号写成 ""。
	if !strings.Contains(lines[1], `,"'=HYPERLINK(""x"")",66,manual,1.0000,permanent,success,`) {
		t.Fatalf("公式注入未转义或额度换算错误: %q", lines[1])
	}
	if !strings.Contains(lines[2], ",alice,42,draw,0.0002,temporary,failed,'-timeout") {
		t.Fatalf("失败流水行: %q", lines[2])
	}
	if !strings.Contains(lines[3], ",alice,42,checkin,0.5000,permanent,success,") {
		t.Fatalf("成功流水行: %q", lines[3])
	}
	// 时间按签到配置时区(纽约)而非 UTC:取当前时刻在纽约的日期前缀核对。
	nyDate := grants[0].CreatedAt.In(service.LoadLocationOr("America/New_York")).Format("2006-01-02")
	if !strings.Contains(lines[3], ","+nyDate+" ") {
		t.Fatalf("时间应按签到时区格式化, line = %q, want date %s", lines[3], nyDate)
	}

	// 筛选与列表一致:status=failed 只导出 1 行。
	rec = perform(adminRoutes(app), http.MethodGet, "/api/admin/grants/export?status=failed&search=alice", []*http.Cookie{cookie})
	filtered := strings.Split(strings.TrimRight(strings.TrimPrefix(rec.Body.String(), "\xEF\xBB\xBF"), "\r\n"), "\r\n")
	if len(filtered) != 2 || !strings.Contains(filtered[1], ",draw,") {
		t.Fatalf("筛选导出应只有 1 行 draw: %q", filtered)
	}
	// 超长搜索词与列表同样 400。
	rec = perform(adminRoutes(app), http.MethodGet, "/api/admin/grants/export?search="+strings.Repeat("a", 129), []*http.Cookie{cookie})
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("超长 search 应 400, got %d", rec.Code)
	}
}
