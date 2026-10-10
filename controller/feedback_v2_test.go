package controller

import (
	"bytes"
	"fmt"
	"image"
	"image/png"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"welfare/model"
	"welfare/service"

	"github.com/gin-gonic/gin"
)

func feedbackV2ControllerRoutes(t *testing.T, app *App) *gin.Engine {
	t.Helper()
	store, err := service.OpenFeedbackImageStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { store.Close() })
	app.FeedbackImages = store
	r := gin.New()
	api := r.Group("/api/v2", FeedbackNoStore)
	api.POST("/feedback", app.Auth.RequireUser(), app.CreateFeedbackV2)
	api.POST("/feedback/:id/replies", app.Auth.RequireUser(), app.ReplyFeedbackV2)
	api.POST("/admin/feedback/:id/replies", app.Auth.RequireAdmin(), app.AdminReplyFeedbackV2)
	return r
}

func feedbackMultipart(t *testing.T, payloads []string, files int, unknown bool) ([]byte, string) {
	t.Helper()
	var b bytes.Buffer
	writer := multipart.NewWriter(&b)
	for _, payload := range payloads {
		part, err := writer.CreateFormField("payload")
		if err != nil {
			t.Fatal(err)
		}
		part.Write([]byte(payload))
	}
	var pngBytes bytes.Buffer
	if err := png.Encode(&pngBytes, image.NewNRGBA(image.Rect(0, 0, 4, 4))); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < files; i++ {
		part, err := writer.CreateFormFile("images", "untrusted-private-name.svg")
		if err != nil {
			t.Fatal(err)
		}
		part.Write(pngBytes.Bytes())
	}
	if unknown {
		part, err := writer.CreateFormField("attachment_id")
		if err != nil {
			t.Fatal(err)
		}
		part.Write([]byte("cannot-reuse"))
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	return b.Bytes(), writer.FormDataContentType()
}

func TestFeedbackV2MultipartValidationAndImageOnly(t *testing.T) {
	app := feedbackTestApp(t)
	_, author := adminUsers(t, app)
	r := feedbackV2ControllerRoutes(t, app)
	cookie := sessionCookie(t, app, author.ID)
	valid := `{"client_submission_id":"` + strings.Repeat("a", 32) + `","category":"message","content":""}`
	for _, test := range []struct {
		name     string
		payloads []string
		files    int
		unknown  bool
		status   int
	}{
		{"missing-payload", nil, 1, false, 400}, {"duplicate-payload", []string{valid, valid}, 1, false, 400}, {"unknown-part", []string{valid}, 1, true, 400},
		{"too-many", []string{valid}, 4, false, 413}, {"unknown-json", []string{strings.TrimSuffix(valid, "}") + `,"author_role":"owner"}`}, 1, false, 400},
		{"payload-limit", []string{strings.Repeat(" ", service.FeedbackMaxPayloadBytes) + valid}, 1, false, 413},
		{"empty", []string{valid}, 0, false, 400}, {"image-only", []string{valid}, 3, false, 200}, {"identical-retry", []string{valid}, 3, false, 200},
	} {
		t.Run(test.name, func(t *testing.T) {
			body, contentType := feedbackMultipart(t, test.payloads, test.files, test.unknown)
			req := httptest.NewRequest(http.MethodPost, "/api/v2/feedback", bytes.NewReader(body))
			req.Header.Set("Content-Type", contentType)
			req.AddCookie(cookie)
			rec := httptest.NewRecorder()
			r.ServeHTTP(rec, req)
			if rec.Code != test.status || rec.Header().Get("Cache-Control") != "private, no-store" {
				t.Fatalf("%d %s", rec.Code, rec.Body.String())
			}
			if strings.Contains(rec.Body.String(), "untrusted-private-name") {
				t.Fatal("filename escaped into response")
			}
			if test.status == 200 {
				item := feedbackControllerResponse[service.FeedbackV2Item](t, rec)
				if item.Content != "" || len(item.Images) != 3 {
					t.Fatal("image-only payload")
				}
			}
		})
	}
	var count int64
	app.DB.Model(&model.Feedback{}).Count(&count)
	if count != 1 {
		t.Fatalf("invalid/replayed submissions published %d rows", count)
	}
	app.DB.Model(&model.FeedbackImage{}).Count(&count)
	if count != 3 {
		t.Fatalf("retry created extra image records: %d", count)
	}
	for _, body := range []string{`null`, `{}`, valid + `{}`, `{"client_submission_id":"` + strings.Repeat("A", 32) + `","category":"message","content":"ok"}`, `{"client_submission_id":"` + strings.Repeat("b", 32) + `","category":"message","content":"` + string([]byte{255}) + `"}`} {
		rec := performJSON(r, http.MethodPost, "/api/v2/feedback", body, cookie)
		if rec.Code != 400 {
			t.Fatalf("invalid JSON %d: %s", rec.Code, rec.Body.String())
		}
	}
	req := httptest.NewRequest(http.MethodPost, "/api/v2/feedback", strings.NewReader("not a multipart envelope"))
	req.Header.Set("Content-Type", "multipart/form-data; boundary=broken")
	req.AddCookie(cookie)
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	if rec.Code != 400 {
		t.Fatalf("malformed multipart %d %s", rec.Code, rec.Body.String())
	}
}

func TestFeedbackV2WholeRequestAndFileBounds(t *testing.T) {
	app := feedbackTestApp(t)
	_, author := adminUsers(t, app)
	r := feedbackV2ControllerRoutes(t, app)
	cookie := sessionCookie(t, app, author.ID)
	for _, test := range []struct {
		name          string
		size          int
		contentLength int64
	}{
		{"per-file", service.FeedbackMaxImageBytes + 1, -1}, {"declared-request", 16, service.FeedbackMaxMultipartBytes + 1},
	} {
		t.Run(test.name, func(t *testing.T) {
			var body bytes.Buffer
			writer := multipart.NewWriter(&body)
			part, _ := writer.CreateFormField("payload")
			fmt.Fprintf(part, `{"client_submission_id":"%s","category":"message"}`, strings.Repeat("c", 32))
			part, _ = writer.CreateFormFile("images", "name.png")
			part.Write(make([]byte, test.size))
			writer.Close()
			req := httptest.NewRequest(http.MethodPost, "/api/v2/feedback", &body)
			req.ContentLength = test.contentLength
			req.Header.Set("Content-Type", writer.FormDataContentType())
			req.AddCookie(cookie)
			rec := httptest.NewRecorder()
			r.ServeHTTP(rec, req)
			if rec.Code != 413 {
				t.Fatalf("bounds %d: %s", rec.Code, rec.Body.String())
			}
		})
	}
}
