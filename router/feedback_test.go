package router

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"welfare/config"
	"welfare/model"
	"welfare/service"

	"github.com/gin-gonic/gin"
	"github.com/golang-jwt/jwt/v5"
	"gorm.io/gorm"
)

var feedbackRouterSequence int64

const feedbackRouterSecret = "feedback-router-test-only-secret-1234567890"

type feedbackRouterFixture struct {
	r                       *gin.Engine
	db                      *gorm.DB
	sessions                *service.SessionManager
	author, other, admin    model.User
	disabled, disabledAdmin model.User
}

func newFeedbackRouterFixture(t *testing.T, stores ...*service.FeedbackImageStore) *feedbackRouterFixture {
	t.Helper()
	seq := atomic.AddInt64(&feedbackRouterSequence, 10)
	db, err := model.Open("sqlite", fmt.Sprintf("file:feedback-router-%d?mode=memory&cache=shared", seq))
	if err != nil {
		t.Fatal(err)
	}
	sqlDB, err := db.DB()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { sqlDB.Close() })
	if err := model.Migrate(db); err != nil {
		t.Fatal(err)
	}
	cfg := &config.Config{
		WelfareBaseURL: "http://localhost:8080", WelfareJWTSecret: feedbackRouterSecret,
		NewAPIBaseURL: "http://127.0.0.1:9", QuotaPerUnit: 500000, MaxGrantQuota: 5000000,
	}
	f := &feedbackRouterFixture{db: db, sessions: service.NewSessionManager(feedbackRouterSecret, false), r: gin.New()}
	// Distinct IDs across fixtures keep process-global rate buckets realistic
	// without making one test consume another fixture's posting allowance.
	users := []*model.User{&f.author, &f.other, &f.admin, &f.disabled, &f.disabledAdmin}
	for i, user := range users {
		*user = model.User{ID: 10000 + seq + int64(i), LinuxDOID: fmt.Sprintf("feedback-%d", i), LinuxDOName: fmt.Sprintf("user-%d", i), DisplayName: fmt.Sprintf("用户 %d", i), Status: 1, Note: "secret-admin-note", TrustLevel: 4}
		if i == 2 || i == 4 {
			user.IsAdmin = true
		}
		if i >= 3 {
			user.Status = 2
		}
		if err := db.Create(user).Error; err != nil {
			t.Fatal(err)
		}
	}
	Register(f.r, cfg, db, stores...)
	return f
}

func (f *feedbackRouterFixture) cookie(t *testing.T, userID int64) *http.Cookie {
	t.Helper()
	token, err := f.sessions.Sign(userID)
	if err != nil {
		t.Fatal(err)
	}
	return &http.Cookie{Name: service.SessionCookieName, Value: token}
}

func feedbackExpiredCookie(t *testing.T, id int64) *http.Cookie {
	t.Helper()
	token, err := jwt.NewWithClaims(jwt.SigningMethodHS256, service.Claims{
		UserID: id, RegisteredClaims: jwt.RegisteredClaims{ExpiresAt: jwt.NewNumericDate(time.Now().Add(-time.Hour))},
	}).SignedString([]byte(feedbackRouterSecret))
	if err != nil {
		t.Fatal(err)
	}
	return &http.Cookie{Name: service.SessionCookieName, Value: token}
}

func (f *feedbackRouterFixture) request(t *testing.T, method, path, body string, cookie *http.Cookie) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	if cookie != nil {
		req.AddCookie(cookie)
	}
	rec := httptest.NewRecorder()
	f.r.ServeHTTP(rec, req)
	if rec.Header().Get("Cache-Control") != "private, no-store" {
		t.Fatalf("%s %s (%d) missing no-store: %v", method, path, rec.Code, rec.Header())
	}
	return rec
}

func feedbackResponse[T any](t *testing.T, rec *httptest.ResponseRecorder) T {
	t.Helper()
	var out struct {
		Success bool `json:"success"`
		Data    T    `json:"data"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil || !out.Success || rec.Code != http.StatusOK {
		t.Fatalf("invalid successful feedback response: code=%d body=%s err=%v", rec.Code, rec.Body.String(), err)
	}
	return out.Data
}

func assertFeedbackPublicProjection(t *testing.T, raw string) {
	t.Helper()
	for _, forbidden := range []string{`"user_id"`, `"admin_user_id"`, `"linux_do_id"`, `"linux_do_name"`, `"newapi_user_id"`, `"newapi_username"`, `"trust_level"`, `"is_admin"`, `"note"`, "secret-admin-note"} {
		if strings.Contains(raw, forbidden) {
			t.Fatalf("wall response leaked %s: %s", forbidden, raw)
		}
	}
}

func TestFeedbackRouterPrivacyMatrix(t *testing.T) {
	f := newFeedbackRouterFixture(t)
	var entries []model.Feedback
	for _, private := range []bool{false, true} {
		for _, hidden := range []bool{false, true} {
			entry := model.Feedback{UserID: f.author.ID, Category: "issue", Content: fmt.Sprintf("entry-private=%t-hidden=%t", private, hidden), IsPrivate: private, IsHidden: hidden, Status: "pending"}
			if private && hidden {
				entry.Status = "resolved"
			}
			if err := f.db.Create(&entry).Error; err != nil {
				t.Fatal(err)
			}
			for i := 0; i < 2; i++ {
				reply := model.FeedbackReply{FeedbackID: entry.ID, UserID: f.admin.ID, Content: fmt.Sprintf("reply-%d-for-%d", i, entry.ID)}
				if err := f.db.Create(&reply).Error; err != nil {
					t.Fatal(err)
				}
			}
			entries = append(entries, entry)
		}
	}
	otherEntry := model.Feedback{UserID: f.other.ID, Category: "message", Content: "other-private", IsPrivate: true}
	if err := f.db.Create(&otherEntry).Error; err != nil {
		t.Fatal(err)
	}
	viewers := []struct {
		name       string
		cookie     *http.Cookie
		canPrivate bool
		mineCount  int
	}{
		{"guest", nil, false, -1},
		{"author", f.cookie(t, f.author.ID), true, 4},
		{"other", f.cookie(t, f.other.ID), false, 1},
		{"admin", f.cookie(t, f.admin.ID), true, 0},
		{"invalid", &http.Cookie{Name: service.SessionCookieName, Value: "bad-session"}, false, -1},
		{"expired", feedbackExpiredCookie(t, f.author.ID), false, -1},
		{"missing-user", f.cookie(t, 99999999), false, -1},
		{"disabled", f.cookie(t, f.disabled.ID), false, -1},
		{"disabled-admin", f.cookie(t, f.disabledAdmin.ID), false, -1},
	}
	for _, viewer := range viewers {
		t.Run(viewer.name, func(t *testing.T) {
			for _, query := range []string{"", "?category=issue&status=pending&page_size=1&visibility=private&moderation=hidden&search=entry-private&user_id=999999"} {
				rec := f.request(t, http.MethodGet, "/api/feedback"+query, "", viewer.cookie)
				page := feedbackResponse[service.FeedbackPage[service.FeedbackItem]](t, rec)
				if page.Total != 1 || len(page.Items) != 1 || page.Items[0].ID != entries[0].ID || page.Items[0].ReplyCount != 2 {
					t.Fatalf("public scope/count changed with session/filter: %+v", page)
				}
				assertFeedbackPublicProjection(t, rec.Body.String())
				for _, entry := range entries[1:] {
					if strings.Contains(rec.Body.String(), entry.Content) {
						t.Fatal("public list leaked a restricted entry")
					}
				}
			}
			rec := f.request(t, http.MethodGet, "/api/feedback?status=resolved", "", viewer.cookie)
			page := feedbackResponse[service.FeedbackPage[service.FeedbackItem]](t, rec)
			if page.Total != 0 || page.Items == nil || len(page.Items) != 0 {
				t.Fatalf("private status counts leaked: %+v", page)
			}
			for i, entry := range entries {
				rec := f.request(t, http.MethodGet, fmt.Sprintf("/api/feedback/%d?page=2&page_size=1", entry.ID), "", viewer.cookie)
				if i != 0 && !viewer.canPrivate {
					if rec.Code != http.StatusNotFound || strings.Contains(rec.Body.String(), entry.Content) || !strings.Contains(rec.Body.String(), `"data":null`) {
						t.Fatalf("inaccessible detail leaked: %d %s", rec.Code, rec.Body.String())
					}
					missing := f.request(t, http.MethodGet, "/api/feedback/99999999", "", viewer.cookie)
					if missing.Code != rec.Code || missing.Body.String() != rec.Body.String() {
						t.Fatal("missing/inaccessible entries have distinguishable responses")
					}
					continue
				}
				detail := feedbackResponse[service.FeedbackDetail](t, rec)
				if detail.Message.ID != entry.ID || detail.Message.ReplyCount != 2 || detail.Replies.Total != 2 || detail.Replies.Page != 2 || len(detail.Replies.Items) != 1 || detail.Replies.Items[0].Content != fmt.Sprintf("reply-1-for-%d", entry.ID) {
					t.Fatalf("authorized detail/reply pagination failed: %+v", detail)
				}
				assertFeedbackPublicProjection(t, rec.Body.String())
			}
			rec = f.request(t, http.MethodGet, fmt.Sprintf("/api/user/feedback?user_id=%d", f.author.ID), "", viewer.cookie)
			if viewer.mineCount < 0 {
				if rec.Code != http.StatusUnauthorized {
					t.Fatalf("personal history should require a valid session, got %d", rec.Code)
				}
			} else {
				page := feedbackResponse[service.FeedbackPage[service.FeedbackItem]](t, rec)
				if page.Total != int64(viewer.mineCount) || len(page.Items) != viewer.mineCount {
					t.Fatalf("personal history ignored current author: %+v", page)
				}
				if viewer.name == "other" && page.Items[0].ID != otherEntry.ID {
					t.Fatal("client-supplied user ID replaced current identity")
				}
				assertFeedbackPublicProjection(t, rec.Body.String())
			}
		})
	}
}

func TestFeedbackRouterPostingAndLimiter(t *testing.T) {
	f := newFeedbackRouterFixture(t)
	body := `{"category":"issue","content":"未绑定用户也可以反馈"}`
	for _, cookie := range []*http.Cookie{nil, {Name: service.SessionCookieName, Value: "bad"}, feedbackExpiredCookie(t, f.author.ID), f.cookie(t, f.disabled.ID)} {
		rec := f.request(t, http.MethodPost, "/api/feedback", body, cookie)
		if rec.Code != http.StatusUnauthorized {
			t.Fatalf("posting accepted an invalid session: %d %s", rec.Code, rec.Body.String())
		}
	}
	cookie := f.cookie(t, f.author.ID)
	for i := 0; i < 3; i++ {
		rec := f.request(t, http.MethodPost, "/api/feedback", body, cookie)
		item := feedbackResponse[service.FeedbackItem](t, rec)
		if item.ID <= 0 || item.IsPrivate || item.IsHidden || item.Status == nil || *item.Status != "pending" || item.Author.Name != f.author.DisplayName {
			t.Fatalf("create contract failed: %+v", item)
		}
		assertFeedbackPublicProjection(t, rec.Body.String())
	}
	rec := f.request(t, http.MethodPost, "/api/feedback", body, cookie)
	if rec.Code != http.StatusTooManyRequests {
		t.Fatalf("real posting route omitted feedback limiter: %d %s", rec.Code, rec.Body.String())
	}
	rec = f.request(t, http.MethodPost, "/api/feedback", body, f.cookie(t, f.other.ID))
	feedbackResponse[service.FeedbackItem](t, rec)
	var count int64
	if err := f.db.Model(&model.Feedback{}).Count(&count).Error; err != nil || count != 4 {
		t.Fatalf("rejected posts wrote entries: count=%d err=%v", count, err)
	}
}

func TestFeedbackRouterDisabledAuthorLosesPrivateHistory(t *testing.T) {
	f := newFeedbackRouterFixture(t)
	entry := model.Feedback{UserID: f.author.ID, Category: "message", Content: "previously readable private content", IsPrivate: true}
	if err := f.db.Create(&entry).Error; err != nil {
		t.Fatal(err)
	}
	cookie := f.cookie(t, f.author.ID)
	path := fmt.Sprintf("/api/feedback/%d", entry.ID)
	rec := f.request(t, http.MethodGet, path, "", cookie)
	feedbackResponse[service.FeedbackDetail](t, rec)
	if err := f.db.Model(&f.author).Update("status", 2).Error; err != nil {
		t.Fatal(err)
	}
	for _, test := range []struct {
		method, path, body string
		code               int
	}{
		{http.MethodGet, path, "", http.StatusNotFound},
		{http.MethodGet, "/api/user/feedback", "", http.StatusUnauthorized},
		{http.MethodPost, "/api/feedback", `{"category":"message","content":"must be rejected"}`, http.StatusUnauthorized},
	} {
		rec := f.request(t, test.method, test.path, test.body, cookie)
		if rec.Code != test.code || strings.Contains(rec.Body.String(), entry.Content) {
			t.Fatalf("disabled author retained previous private access: %s %s => %d %s", test.method, test.path, rec.Code, rec.Body.String())
		}
	}
	// Optional auth still allows the public wall, with no private placeholders/counts.
	rec = f.request(t, http.MethodGet, "/api/feedback", "", cookie)
	page := feedbackResponse[service.FeedbackPage[service.FeedbackItem]](t, rec)
	if page.Total != 0 || page.Items == nil || len(page.Items) != 0 {
		t.Fatalf("disabled session exposed private list state: %+v", page)
	}
}

func TestFeedbackRouterAdminGuardsAndRevocation(t *testing.T) {
	f := newFeedbackRouterFixture(t)
	entry := model.Feedback{UserID: f.author.ID, Category: "issue", Content: "private admin test", IsPrivate: true, Status: "pending"}
	if err := f.db.Create(&entry).Error; err != nil {
		t.Fatal(err)
	}
	base := fmt.Sprintf("/api/admin/feedback/%d", entry.ID)
	routes := []struct{ method, path, body string }{
		{http.MethodGet, "/api/admin/feedback", ""},
		{http.MethodGet, base, ""},
		{http.MethodPost, base + "/replies", `{"content":"owner reply"}`},
		{http.MethodPut, base + "/status", `{"status":"in_progress"}`},
		{http.MethodPut, base + "/moderation", `{"is_hidden":true}`},
	}
	for _, viewer := range []struct {
		cookie *http.Cookie
		code   int
	}{
		{nil, http.StatusUnauthorized}, {f.cookie(t, f.author.ID), http.StatusForbidden},
		{f.cookie(t, f.disabledAdmin.ID), http.StatusUnauthorized}, {feedbackExpiredCookie(t, f.admin.ID), http.StatusUnauthorized},
	} {
		for _, route := range routes {
			rec := f.request(t, route.method, route.path, route.body, viewer.cookie)
			if rec.Code != viewer.code {
				t.Fatalf("%s %s: wanted %d got %d %s", route.method, route.path, viewer.code, rec.Code, rec.Body.String())
			}
		}
	}
	cookie := f.cookie(t, f.admin.ID)
	for _, route := range routes {
		rec := f.request(t, route.method, route.path, route.body, cookie)
		if rec.Code != http.StatusOK {
			t.Fatalf("admin route not wired correctly: %s %s => %d %s", route.method, route.path, rec.Code, rec.Body.String())
		}
	}
	var logCount int64
	if err := f.db.Model(&model.AdminLog{}).Count(&logCount).Error; err != nil || logCount != 3 {
		t.Fatalf("admin successful writes should audit: %d err=%v", logCount, err)
	}
	if err := f.db.Model(&f.admin).Update("is_admin", false).Error; err != nil {
		t.Fatal(err)
	}
	for _, route := range routes {
		rec := f.request(t, route.method, route.path, route.body, cookie)
		if rec.Code != http.StatusForbidden {
			t.Fatalf("revoked admin cookie retained access: %s %s => %d", route.method, route.path, rec.Code)
		}
	}
	rec := f.request(t, http.MethodGet, fmt.Sprintf("/api/feedback/%d", entry.ID), "", cookie)
	if rec.Code != http.StatusNotFound {
		t.Fatal("revoked admin recovered private detail via optional session")
	}
	if err := f.db.Model(&f.admin).Updates(map[string]any{"is_admin": true, "status": 2}).Error; err != nil {
		t.Fatal(err)
	}
	for _, route := range routes {
		rec := f.request(t, route.method, route.path, route.body, cookie)
		if rec.Code != http.StatusUnauthorized {
			t.Fatalf("disabled admin cookie retained access: %d", rec.Code)
		}
	}
	var finalCount int64
	if err := f.db.Model(&model.AdminLog{}).Count(&finalCount).Error; err != nil || finalCount != logCount {
		t.Fatal("denied admin writes generated audit records")
	}
}
