package controller

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"welfare/model"
	"welfare/service"

	"github.com/gin-gonic/gin"
	"gorm.io/gorm"
)

func feedbackTestApp(t *testing.T) *App {
	t.Helper()
	db := sqliteTestDB()
	sqlDB, err := db.DB()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { sqlDB.Close() })
	if err := model.Migrate(db); err != nil {
		t.Fatal(err)
	}
	return NewApp(db, testConfig("http://127.0.0.1:9"))
}

func feedbackControllerRoutes(app *App) *gin.Engine {
	r := adminRoutes(app)
	api := r.Group("/api", FeedbackNoStore)
	api.GET("/feedback", app.ListFeedback)
	api.GET("/feedback/:id", app.Auth.OptionalUser(), app.FeedbackDetail)
	api.GET("/user/feedback", app.Auth.RequireUser(), app.MyFeedback)
	// Rate limiting is exercised against router.Register in router/feedback_test.go;
	// controller input validation must not consume the process-global token bucket.
	api.POST("/feedback", app.Auth.RequireUser(), app.CreateFeedback)
	return r
}

func feedbackControllerResponse[T any](t *testing.T, rec *httptest.ResponseRecorder) T {
	t.Helper()
	var response struct {
		Success bool `json:"success"`
		Data    T    `json:"data"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &response); err != nil || !response.Success || rec.Code != http.StatusOK {
		t.Fatalf("unexpected feedback response: code=%d body=%s err=%v", rec.Code, rec.Body.String(), err)
	}
	return response.Data
}

func TestFeedbackHTTPValidationAndDefaults(t *testing.T) {
	app := feedbackTestApp(t)
	admin, author := adminUsers(t, app)
	r := feedbackControllerRoutes(app)
	cookie := sessionCookie(t, app, author.ID)
	for _, body := range []string{
		``, `null`, `[]`, `{}`, `{`,
		`{"category":"message"}`,
		`{"content":"hello"}`,
		`{"category":"unknown","content":"hello"}`,
		`{"category":"message","content":"  \n\t"}`,
		`{"category":"message","content":42}`,
		`{"category":"message","content":"hello","is_private":"false"}`,
		`{"category":"message","content":"hello","user_id":99999}`,
		`{"category":"message","content":"hello","is_hidden":false}`,
		`{"category":"message","content":"hello","status":"resolved"}`,
		`{"category":"message","content":"hello"} {}`,
		`{"category":"message","content":"` + string([]byte{0xff}) + `"}`,
		`{"category":"message","content":"` + strings.Repeat("🍀", 2001) + `"}`,
		strings.Repeat(" ", feedbackMaxRequestBytes) + `{"category":"message","content":"hello"}`,
	} {
		rec := performJSON(r, http.MethodPost, "/api/feedback", body, cookie)
		if rec.Code != http.StatusBadRequest || rec.Header().Get("Cache-Control") != "private, no-store" {
			t.Errorf("invalid feedback request should fail without caching: status=%d bytes=%d body=%s", rec.Code, len(body), rec.Body.String())
		}
	}
	var count int64
	if err := app.DB.Model(&model.Feedback{}).Count(&count).Error; err != nil || count != 0 {
		t.Fatalf("invalid input wrote feedback: count=%d err=%v", count, err)
	}
	for _, category := range []string{"message", "praise", "issue", "suggestion"} {
		body, err := json.Marshal(map[string]any{"category": category, "content": " \n" + strings.Repeat("🍀", 2000) + "\n "})
		if err != nil {
			t.Fatal(err)
		}
		rec := performJSON(r, http.MethodPost, "/api/feedback", string(body), cookie)
		item := feedbackControllerResponse[service.FeedbackItem](t, rec)
		if item.Content != strings.Repeat("🍀", 2000) || item.Category != category || item.IsPrivate || item.IsHidden || item.CreatedAt.IsZero() || item.UpdatedAt.IsZero() {
			t.Fatalf("created entry contract failed: %+v", item)
		}
		if category == "message" || category == "praise" {
			if !strings.Contains(rec.Body.String(), `"status":null`) {
				t.Fatal("non-workflow status must be explicit null")
			}
		} else if item.Status == nil || *item.Status != "pending" {
			t.Fatal("workflow category must start pending")
		}
	}
	for _, id := range []string{"0", "-1", "no-id", "9999999999999999999999999999999999999"} {
		rec := perform(r, http.MethodGet, "/api/feedback/"+id, nil)
		if rec.Code != http.StatusBadRequest {
			t.Errorf("invalid ID %q returned %d", id, rec.Code)
		}
	}
	for _, query := range []string{"category=invalid", "status=invalid"} {
		rec := perform(r, http.MethodGet, "/api/feedback?"+query, nil)
		if rec.Code != http.StatusBadRequest {
			t.Errorf("invalid public filter %s returned %d", query, rec.Code)
		}
	}
	adminCookie := sessionCookie(t, app, admin.ID)
	for _, query := range []string{"visibility=invalid", "moderation=invalid", "search=" + url.QueryEscape(strings.Repeat("🍀", 101))} {
		rec := perform(r, http.MethodGet, "/api/admin/feedback?"+query, []*http.Cookie{adminCookie})
		if rec.Code != http.StatusBadRequest {
			t.Errorf("invalid admin filter %s returned %d", query, rec.Code)
		}
	}
	for _, query := range []string{"page=-1&page_size=101", "page=1000001&page_size=0", "page=99999999999999999999999999999999999&page_size=nope"} {
		rec := perform(r, http.MethodGet, "/api/feedback?"+query, nil)
		page := feedbackControllerResponse[service.FeedbackPage[service.FeedbackItem]](t, rec)
		if page.Page != 1 || page.PageSize != 20 || page.Total != 4 {
			t.Fatalf("invalid pagination was not normalized: %+v", page)
		}
	}
}

func TestFeedbackHTTPAdminMutationValidation(t *testing.T) {
	app := feedbackTestApp(t)
	admin, author := adminUsers(t, app)
	cookie := sessionCookie(t, app, admin.ID)
	r := feedbackControllerRoutes(app)
	entry := model.Feedback{UserID: author.ID, Category: "message", Content: "a message", IsPrivate: true}
	if err := app.DB.Create(&entry).Error; err != nil {
		t.Fatal(err)
	}
	base := fmt.Sprintf("/api/admin/feedback/%d", entry.ID)
	for _, test := range []struct{ method, suffix, body string }{
		{http.MethodPost, "/replies", `{"content":"  "}`},
		{http.MethodPost, "/replies", `{"content":"hello","admin_user_id":99999}`},
		{http.MethodPost, "/replies", `{"content":"` + strings.Repeat("🍀", 2001) + `"}`},
		{http.MethodPost, "/replies", `{"content":"` + string([]byte{0xff}) + `"}`},
		{http.MethodPost, "/replies", strings.Repeat(" ", feedbackMaxRequestBytes) + `{"content":"reply"}`},
		{http.MethodPut, "/status", `{"status":"resolved"}`},
		{http.MethodPut, "/status", `{"status":"unknown"}`},
		{http.MethodPut, "/status", `{}`},
		{http.MethodPut, "/moderation", `{}`},
		{http.MethodPut, "/moderation", `{"is_hidden":null}`},
		{http.MethodPut, "/moderation", `{"is_hidden":"false"}`},
		{http.MethodPut, "/moderation", `{"is_hidden":true,"is_private":false}`},
	} {
		rec := performJSON(r, test.method, base+test.suffix, test.body, cookie)
		if rec.Code != http.StatusBadRequest {
			t.Errorf("invalid admin request %s %s => %d %s", test.method, test.suffix, rec.Code, rec.Body.String())
		}
	}
	for _, test := range []struct{ method, suffix, body string }{
		{http.MethodPost, "/replies", `{"content":"hello"}`},
		{http.MethodPut, "/status", `{"status":"resolved"}`},
		{http.MethodPut, "/moderation", `{"is_hidden":true}`},
	} {
		rec := performJSON(r, test.method, "/api/admin/feedback/999999"+test.suffix, test.body, cookie)
		if rec.Code != http.StatusNotFound {
			t.Errorf("missing entry mutation returned %d", rec.Code)
		}
	}
	if rows := auditRows(t, app, ""); len(rows) != 0 {
		t.Fatalf("rejected feedback mutations must not audit: %+v", rows)
	}
	var count int64
	if err := app.DB.Model(&model.FeedbackReply{}).Count(&count).Error; err != nil || count != 0 {
		t.Fatal("invalid replies wrote rows")
	}
	rec := performJSON(r, http.MethodPost, base+"/replies", `{"content":"\n`+strings.Repeat("🍀", 2000)+`\n"}`, cookie)
	reply := feedbackControllerResponse[service.FeedbackReply](t, rec)
	if reply.Content != strings.Repeat("🍀", 2000) {
		t.Fatal("reply code point boundary differs from message boundary")
	}
}

// Called from the existing all-admin-writes audit regression, so additions to
// the action taxonomy are covered alongside the logs filter/projection routes.
func assertFeedbackAdminAudits(t *testing.T, app *App, admin, author model.User) {
	t.Helper()
	r := adminRoutes(app)
	cookie := sessionCookie(t, app, admin.ID)
	entry := model.Feedback{UserID: author.ID, Category: "issue", Content: "private-feedback-body", IsPrivate: true, Status: "pending"}
	if err := app.DB.Create(&entry).Error; err != nil {
		t.Fatal(err)
	}
	base := fmt.Sprintf("/api/admin/feedback/%d", entry.ID)
	for _, write := range []struct{ method, suffix, body string }{
		{http.MethodPost, "/replies", `{"content":"private-reply-body 🍀"}`},
		{http.MethodPut, "/status", `{"status":"resolved"}`},
		{http.MethodPut, "/status", `{"status":"resolved"}`},
		{http.MethodPut, "/moderation", `{"is_hidden":true}`},
		{http.MethodPut, "/moderation", `{"is_hidden":true}`},
		{http.MethodPut, "/moderation", `{"is_hidden":false}`},
		{http.MethodPut, "/moderation", `{"is_hidden":false}`},
	} {
		rec := performJSON(r, write.method, base+write.suffix, write.body, cookie)
		if rec.Code != http.StatusOK {
			t.Fatalf("feedback audit write failed: %s %d %s", write.suffix, rec.Code, rec.Body.String())
		}
	}
	denied := performJSON(r, http.MethodPut, base+"/status", `{"status":"pending"}`, sessionCookie(t, app, author.ID))
	if denied.Code != http.StatusForbidden {
		t.Fatal("non-admin feedback mutation was accepted")
	}
	invalid := performJSON(r, http.MethodPut, base+"/moderation", `{}`, cookie)
	if invalid.Code != http.StatusBadRequest {
		t.Fatal("missing moderation boolean was accepted")
	}
	missing := performJSON(r, http.MethodPost, "/api/admin/feedback/999999/replies", `{"content":"missing"}`, cookie)
	if missing.Code != http.StatusNotFound {
		t.Fatal("missing feedback reply was accepted")
	}
	for _, action := range []string{service.AuditReplyFeedback, service.AuditUpdateFeedbackStatus, service.AuditHideFeedback, service.AuditRestoreFeedback} {
		rows := auditRows(t, app, action)
		if len(rows) != 1 {
			t.Fatalf("successful %s should audit once (no-op/denied excluded): %+v", action, rows)
		}
		row := rows[0]
		if row.AdminUserID != admin.ID || row.TargetType != service.AuditTargetFeedback || row.TargetID != entry.ID || row.IP == "" {
			t.Fatalf("feedback audit attribution incorrect: %+v", row)
		}
		for _, forbidden := range []string{entry.Content, "private-reply-body", "content", "author", "newapi"} {
			if strings.Contains(row.Detail, forbidden) {
				t.Fatalf("feedback audit copied private data: %s", row.Detail)
			}
		}
		var detail map[string]any
		if err := json.Unmarshal([]byte(row.Detail), &detail); err != nil {
			t.Fatalf("feedback audit detail is not JSON: %v", err)
		}
		if action == service.AuditReplyFeedback {
			if detail["reply_id"].(float64) <= 0 || detail["character_count"] != float64(20) {
				t.Fatalf("reply audit should contain only ID and code point length: %s", row.Detail)
			}
		} else if action == service.AuditUpdateFeedbackStatus {
			if detail["before"].(map[string]any)["status"] != "pending" || detail["after"].(map[string]any)["status"] != "resolved" {
				t.Fatalf("status audit lost the before snapshot: %s", row.Detail)
			}
		} else {
			wantHidden := action == service.AuditHideFeedback
			if detail["before"].(map[string]any)["is_hidden"] != !wantHidden || detail["after"].(map[string]any)["is_hidden"] != wantHidden {
				t.Fatalf("moderation audit lost the before/after snapshot: %s", row.Detail)
			}
		}
	}
	var saved model.Feedback
	if err := app.DB.First(&saved, entry.ID).Error; err != nil || !saved.IsPrivate || saved.IsHidden || saved.Status != "resolved" {
		t.Fatalf("restoring changed privacy or status: %+v err=%v", saved, err)
	}
}

func TestFeedbackAuditFailureDoesNotUndoReply(t *testing.T) {
	app := feedbackTestApp(t)
	admin, author := adminUsers(t, app)
	entry := model.Feedback{UserID: author.ID, Category: "issue", Content: "private", IsPrivate: true, Status: "pending"}
	if err := app.DB.Create(&entry).Error; err != nil {
		t.Fatal(err)
	}
	if err := app.DB.Callback().Create().Before("gorm:create").Register("feedback:test-audit-failure", func(tx *gorm.DB) {
		if tx.Statement.Table == "w_admin_logs" {
			tx.AddError(errors.New("forced audit failure"))
		}
	}); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { app.DB.Callback().Create().Remove("feedback:test-audit-failure") })
	r := adminRoutes(app)
	rec := performJSON(r, http.MethodPost, fmt.Sprintf("/api/admin/feedback/%d/replies", entry.ID), `{"content":"recorded reply"}`, sessionCookie(t, app, admin.ID))
	reply := feedbackControllerResponse[service.FeedbackReply](t, rec)
	var saved model.FeedbackReply
	if err := app.DB.First(&saved, reply.ID).Error; err != nil || saved.Content != "recorded reply" {
		t.Fatalf("audit failure rolled back a successful reply: %+v err=%v", saved, err)
	}
}

func TestFeedbackStorageErrorsStayGeneric(t *testing.T) {
	app := feedbackTestApp(t)
	if err := app.DB.Callback().Query().Before("gorm:query").Register("feedback:test-query-failure", func(tx *gorm.DB) {
		if tx.Statement.Table == "w_feedbacks" {
			tx.AddError(errors.New("SELECT private-secret FROM w_feedbacks"))
		}
	}); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { app.DB.Callback().Query().Remove("feedback:test-query-failure") })
	for _, path := range []string{"/api/feedback", "/api/feedback/1"} {
		rec := perform(feedbackControllerRoutes(app), http.MethodGet, path, nil)
		if rec.Code != http.StatusInternalServerError || strings.Contains(rec.Body.String(), "private-secret") || strings.Contains(rec.Body.String(), "SELECT") || rec.Header().Get("Cache-Control") != "private, no-store" {
			t.Fatalf("storage failure exposed details or wrong status: %d %s", rec.Code, rec.Body.String())
		}
	}
}
