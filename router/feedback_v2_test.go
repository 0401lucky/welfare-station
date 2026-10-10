package router

import (
	"bytes"
	"context"
	"fmt"
	"image"
	"image/png"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"welfare/model"
	"welfare/service"
)

func routerFeedbackImages(t *testing.T) (*service.FeedbackImageStore, []byte) {
	t.Helper()
	store, err := service.OpenFeedbackImageStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { store.Close() })
	var data bytes.Buffer
	if err := png.Encode(&data, image.NewNRGBA(image.Rect(0, 0, 3, 4))); err != nil {
		t.Fatal(err)
	}
	return store, data.Bytes()
}

func routerFeedbackAttempt(t *testing.T, store *service.FeedbackImageStore, raw []byte) *service.FeedbackImageAttempt {
	t.Helper()
	a, err := store.Begin(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(a.Close)
	if err := a.AddImage(context.Background(), bytes.NewReader(raw)); err != nil {
		t.Fatal(err)
	}
	return a
}

func TestFeedbackV2RouterImagesAndParentReplyPermissionMatrix(t *testing.T) {
	store, raw := routerFeedbackImages(t)
	f := newFeedbackRouterFixture(t, store)
	for _, private := range []bool{false, true} {
		a := routerFeedbackAttempt(t, store, raw)
		key := fmt.Sprintf("%032x", 1)
		if private {
			key = fmt.Sprintf("%032x", 2)
		}
		item, err := service.CreateFeedbackV2(f.db, &f.author, service.CreateFeedbackV2Input{ClientSubmissionID: key, Category: "issue", IsPrivate: private}, a)
		a.Close()
		if err != nil {
			t.Fatal(err)
		}
		// The author can reply to either parent. Other members have no right to
		// a private root; an owner reply remains historically attributed.
		a = routerFeedbackAttempt(t, store, raw)
		reply, err := service.AppendFeedbackReplyV2(f.db, item.ID, &f.author, service.ReplyFeedbackV2Input{ClientSubmissionID: key}, a, false, "")
		a.Close()
		if err != nil {
			t.Fatal(err)
		}
		for _, hidden := range []bool{false, true} {
			if _, err := service.UpdateFeedbackModeration(f.db, item.ID, &f.admin, hidden); err != nil {
				t.Fatal(err)
			}
			for _, replyHidden := range []bool{false, true} {
				if _, err := service.ModerateFeedbackReplyV2(f.db, item.ID, reply.ID, &f.admin, replyHidden, ""); err != nil {
					t.Fatal(err)
				}
				for _, viewer := range []struct {
					name    string
					user    *model.User
					expired bool
				}{
					{"guest", nil, false}, {"author", &f.author, false}, {"other", &f.other, false}, {"admin", &f.admin, false}, {"disabled", &f.disabled, false}, {"disabled-admin", &f.disabledAdmin, false}, {"expired-author", &f.author, true},
				} {
					var cookie *http.Cookie
					if viewer.user != nil {
						cookie = f.cookie(t, viewer.user.ID)
						if viewer.expired {
							cookie = feedbackExpiredCookie(t, viewer.user.ID)
						}
					}
					active := viewer.user != nil && viewer.user.Status == 1 && !viewer.expired
					parentAllowed := (!private && !hidden) || (active && (viewer.user.ID == f.author.ID || viewer.user.IsAdmin))
					for _, test := range []struct {
						id    string
						child bool
					}{{item.Images[0].ID, false}, {reply.Images[0].ID, true}} {
						allowed := parentAllowed && (!test.child || !replyHidden || (active && (viewer.user.ID == f.author.ID || viewer.user.IsAdmin)))
						for _, variant := range []string{"original", "thumbnail"} {
							for _, method := range []string{http.MethodGet, http.MethodHead} {
								path := "/api/v2/feedback/images/" + test.id + "/" + variant
								req := httptest.NewRequest(method, path, nil)
								req.Header.Set("If-None-Match", "*")
								req.Header.Set("If-Modified-Since", "Thu, 01 Jan 2099 00:00:00 GMT")
								req.Header.Set("Range", "bytes=0-4")
								if cookie != nil {
									req.AddCookie(cookie)
								}
								rec := httptest.NewRecorder()
								f.r.ServeHTTP(rec, req)
								want := 404
								if allowed {
									want = 200
								}
								if rec.Code != want || rec.Header().Get("Cache-Control") != "private, no-store" {
									t.Fatalf("%s %s private=%v hidden=%v child=%v childHidden=%v status=%d body=%s", viewer.name, method, private, hidden, test.child, replyHidden, rec.Code, rec.Body.String())
								}
								if allowed {
									if rec.Header().Get("X-Content-Type-Options") != "nosniff" || rec.Header().Get("Content-Type") != "image/png" {
										t.Fatal("unsafe image headers")
									}
									if method == http.MethodGet && variant == "original" && !bytes.Equal(rec.Body.Bytes(), raw) {
										t.Fatal("original bytes changed")
									}
									if method == http.MethodHead && rec.Body.Len() != 0 {
										t.Fatal("HEAD returned image bytes")
									}
								} else if strings.HasPrefix(rec.Header().Get("Content-Type"), "image/") || strings.Contains(rec.Body.String(), test.id) {
									t.Fatal("denied image leaked metadata")
								}
							}
						}
					}
				}
			}
		}
	}
}

func TestFeedbackV2RouterMemberRepliesAndSharedReplyLimiter(t *testing.T) {
	f := newFeedbackRouterFixture(t)
	root := model.Feedback{UserID: f.author.ID, Category: "message", Content: "public"}
	if err := f.db.Create(&root).Error; err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 10; i++ {
		path := fmt.Sprintf("/api/v2/feedback/%d/replies", root.ID)
		if i%2 == 1 {
			path = fmt.Sprintf("/api/v2/admin/feedback/%d/replies", root.ID)
		}
		body := fmt.Sprintf(`{"client_submission_id":"%032x","content":"reply"}`, i+1)
		rec := f.request(t, http.MethodPost, path, body, f.cookie(t, f.admin.ID))
		if rec.Code != 200 {
			t.Fatalf("reply %d: %d %s", i, rec.Code, rec.Body.String())
		}
	}
	rec := f.request(t, http.MethodPost, fmt.Sprintf("/api/v2/feedback/%d/replies", root.ID), fmt.Sprintf(`{"client_submission_id":"%032x","content":"reply"}`, 11), f.cookie(t, f.admin.ID))
	if rec.Code != 429 {
		t.Fatal("admin/user routes did not share reply bucket")
	}
	// Posting and other users retain their independent capacity.
	rec = f.request(t, http.MethodPost, "/api/v2/feedback", fmt.Sprintf(`{"client_submission_id":"%032x","category":"message","content":"post"}`, 21), f.cookie(t, f.admin.ID))
	feedbackResponse[service.FeedbackV2Item](t, rec)
	path := fmt.Sprintf("/api/v2/feedback/%d/replies", root.ID)
	body := fmt.Sprintf(`{"client_submission_id":"%032x","content":"unbound member"}`, 31)
	rec = f.request(t, http.MethodPost, path, body, f.cookie(t, f.other.ID))
	reply := feedbackResponse[service.FeedbackV2Reply](t, rec)
	if reply.AuthorRole != "member" {
		t.Fatal("member mislabeled owner")
	}
	rec = f.request(t, http.MethodGet, fmt.Sprintf("/api/feedback/%d", root.ID), "", nil)
	legacy := feedbackResponse[service.FeedbackDetail](t, rec)
	if legacy.Replies.Total != 10 {
		t.Fatal("legacy count included member")
	}
	for _, cookie := range []*http.Cookie{nil, f.cookie(t, f.disabled.ID), feedbackExpiredCookie(t, f.author.ID)} {
		if rec := f.request(t, http.MethodPost, path, body, cookie); rec.Code != 401 {
			t.Fatal("invalid writer accepted")
		}
	}
	adminPath := fmt.Sprintf("/api/v2/admin/feedback/%d/replies", root.ID)
	if rec := f.request(t, http.MethodPost, adminPath, body, f.cookie(t, f.other.ID)); rec.Code != 403 {
		t.Fatal("member accepted on admin route")
	}
	if err := f.db.Model(&model.User{}).Where("id = ?", f.admin.ID).Update("is_admin", false).Error; err != nil {
		t.Fatal(err)
	}
	if rec := f.request(t, http.MethodGet, "/api/v2/admin/feedback", "", f.cookie(t, f.admin.ID)); rec.Code != 403 {
		t.Fatal("revoked admin retained V2 authority")
	}
}

func TestFeedbackV2RouterReplyAuthorCannotBypassParentOrCurrentRole(t *testing.T) {
	store, raw := routerFeedbackImages(t)
	f := newFeedbackRouterFixture(t, store)
	a := routerFeedbackAttempt(t, store, raw)
	root, err := service.CreateFeedbackV2(f.db, &f.author, service.CreateFeedbackV2Input{ClientSubmissionID: fmt.Sprintf("%032x", 1), Category: "message"}, a)
	a.Close()
	if err != nil {
		t.Fatal(err)
	}
	a = routerFeedbackAttempt(t, store, raw)
	reply, err := service.AppendFeedbackReplyV2(f.db, root.ID, &f.other, service.ReplyFeedbackV2Input{ClientSubmissionID: fmt.Sprintf("%032x", 2)}, a, false, "")
	a.Close()
	if err != nil {
		t.Fatal(err)
	}
	authorCookie, memberCookie, adminCookie := f.cookie(t, f.author.ID), f.cookie(t, f.other.ID), f.cookie(t, f.admin.ID)
	assertAccess := func(imageID string, cookie *http.Cookie, status int) {
		t.Helper()
		for _, variant := range []string{"original", "thumbnail"} {
			for _, method := range []string{http.MethodGet, http.MethodHead} {
				req := httptest.NewRequest(method, "/api/v2/feedback/images/"+imageID+"/"+variant, nil)
				req.Header.Set("If-None-Match", "*")
				if cookie != nil {
					req.AddCookie(cookie)
				}
				rec := httptest.NewRecorder()
				f.r.ServeHTTP(rec, req)
				if rec.Code != status || rec.Header().Get("Cache-Control") != "private, no-store" {
					t.Fatalf("%s %s: got %d, want %d", method, variant, rec.Code, status)
				}
				if status == 404 && (strings.HasPrefix(rec.Header().Get("Content-Type"), "image/") || strings.Contains(rec.Body.String(), imageID)) {
					t.Fatal("denied image exposed protected metadata")
				}
			}
		}
	}
	assertAccess(reply.Images[0].ID, nil, 200)
	if _, err := service.ModerateFeedbackReplyV2(f.db, root.ID, reply.ID, &f.admin, true, ""); err != nil {
		t.Fatal(err)
	}
	assertAccess(root.Images[0].ID, nil, 200)
	assertAccess(reply.Images[0].ID, authorCookie, 404)
	assertAccess(reply.Images[0].ID, memberCookie, 200)
	assertAccess(reply.Images[0].ID, adminCookie, 200)
	if _, err := service.UpdateFeedbackModeration(f.db, root.ID, &f.admin, true); err != nil {
		t.Fatal(err)
	}
	// Owning a reply never grants access to its newly hidden parent.
	assertAccess(root.Images[0].ID, memberCookie, 404)
	assertAccess(reply.Images[0].ID, memberCookie, 404)
	assertAccess(root.Images[0].ID, authorCookie, 200)
	assertAccess(reply.Images[0].ID, authorCookie, 404)
	if _, err := service.ModerateFeedbackReplyV2(f.db, root.ID, reply.ID, &f.admin, false, ""); err != nil {
		t.Fatal(err)
	}
	assertAccess(reply.Images[0].ID, authorCookie, 200)
	assertAccess(reply.Images[0].ID, memberCookie, 404)
	if err := f.db.Model(&model.User{}).Where("id = ?", f.admin.ID).Update("is_admin", false).Error; err != nil {
		t.Fatal(err)
	}
	// Reusing a previously authorized admin cookie still requires today's role.
	assertAccess(root.Images[0].ID, adminCookie, 404)
	assertAccess(reply.Images[0].ID, adminCookie, 404)
}
