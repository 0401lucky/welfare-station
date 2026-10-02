package controller

import (
	"encoding/json"
	"fmt"
	"github.com/gin-gonic/gin"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
	"welfare/model"
	"welfare/service"
)

func TestPacketHTTPPrivacyAndReplay(t *testing.T) {
	app, srv, db := checkinTestApp(t)
	defer srv.Close()
	r := gin.New()
	group := r.Group("/api", app.Auth.RequireUser())
	group.POST("/activities/:id/claim", app.ClaimActivity)
	group.GET("/activities/:id/red-packet", app.RedPacketDetail)
	a := model.Activity{Title: "packet", ClaimMode: "red_packet", PacketMode: "fixed", Quota: 3, TotalQuota: 6, TotalCount: 2, PerUserLimit: 2, StartAt: time.Now().Add(-time.Hour), EndAt: time.Now().Add(time.Hour), Status: 1}
	if err := db.Create(&a).Error; err != nil {
		t.Fatal(err)
	}
	cookie := checkinUser(t, app)
	path := fmt.Sprintf("/api/activities/%d", a.ID)
	for _, tc := range []struct {
		cookies []*http.Cookie
		status  int
	}{{nil, 401}, {[]*http.Cookie{cookie}, 403}} {
		rec := perform(r, http.MethodGet, path+"/red-packet", tc.cookies)
		if rec.Code != tc.status {
			t.Fatalf("privacy %d %s", rec.Code, rec.Body.String())
		}
	}
	post := func(body string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodPost, path+"/claim", strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		req.AddCookie(cookie)
		rec := httptest.NewRecorder()
		r.ServeHTTP(rec, req)
		return rec
	}
	if rec := post(""); rec.Code != 400 {
		t.Fatal("missing sequence accepted", rec.Body.String())
	}
	first := post(`{"expected_seq":1}`)
	if first.Code != 200 {
		t.Fatal(first.Body.String())
	}
	var response struct {
		Data struct {
			ClaimID     int64  `json:"claim_id"`
			Replayed    bool   `json:"replayed"`
			GrantStatus string `json:"grant_status"`
		}
	}
	if err := json.Unmarshal(first.Body.Bytes(), &response); err != nil || response.Data.ClaimID == 0 || response.Data.GrantStatus != "success" {
		t.Fatal(first.Body.String())
	}
	app.NewAPI = service.NewNewAPIClient("http://127.0.0.1:1", "pat")
	replay := post(`{"expected_seq":1}`)
	if err := json.Unmarshal(replay.Body.Bytes(), &response); err != nil || !response.Data.Replayed {
		t.Fatal(replay.Body.String())
	}
	detail := perform(r, http.MethodGet, path+"/red-packet?page_size=1000", []*http.Cookie{cookie})
	if detail.Code != 200 {
		t.Fatal(detail.Body.String())
	}
	for _, key := range []string{"newapi_user_id", "linux_do_id", "user_id", "error"} {
		if strings.Contains(detail.Body.String(), "\""+key+"\"") {
			t.Fatalf("private field %s leaked", key)
		}
	}
}
