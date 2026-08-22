package controller

import (
	"encoding/json"
	"net/http"
	"testing"
	"time"

	"welfare/model"
	"welfare/service"

	"github.com/gin-gonic/gin"
)

func activityRoutes(app *App) *gin.Engine {
	r := gin.New()
	api := r.Group("/api")
	api.GET("/activities", app.Auth.OptionalUser(), app.ListActivities)
	return r
}

func TestListActivitiesOptionalUser(t *testing.T) {
	app, srv, db := checkinTestApp(t)
	defer srv.Close()

	now := time.Now()
	activity := model.Activity{
		Title:        "多次领取",
		Quota:        1000,
		TotalCount:   10,
		PerUserLimit: 2,
		StartAt:      now.Add(-time.Hour),
		EndAt:        now.Add(time.Hour),
		Status:       service.ActivityStatusOn,
	}
	if err := db.Create(&activity).Error; err != nil {
		t.Fatalf("create activity: %v", err)
	}
	user := model.User{LinuxDOID: "activity-viewer", LinuxDOName: "viewer", Status: 1}
	if err := db.Create(&user).Error; err != nil {
		t.Fatalf("create user: %v", err)
	}
	if err := db.Create(&model.Claim{ActivityID: activity.ID, UserID: user.ID, Quota: activity.Quota, Seq: 1}).Error; err != nil {
		t.Fatalf("create claim: %v", err)
	}

	assertState := func(name string, cookies []*http.Cookie, wantCount int, wantReached bool) {
		t.Helper()
		rec := perform(activityRoutes(app), http.MethodGet, "/api/activities", cookies)
		if rec.Code != http.StatusOK {
			t.Fatalf("%s got %d: %s", name, rec.Code, rec.Body.String())
		}
		var response struct {
			Data []struct {
				UserClaimCount        int  `json:"user_claim_count"`
				UserClaimLimitReached bool `json:"user_claim_limit_reached"`
			} `json:"data"`
		}
		if err := json.Unmarshal(rec.Body.Bytes(), &response); err != nil {
			t.Fatalf("%s parse response: %v", name, err)
		}
		if len(response.Data) != 1 || response.Data[0].UserClaimCount != wantCount || response.Data[0].UserClaimLimitReached != wantReached {
			t.Fatalf("%s unexpected claim state: %+v", name, response.Data)
		}
	}

	assertState("anonymous", nil, 0, false)
	assertState("invalid session", []*http.Cookie{{Name: service.SessionCookieName, Value: "invalid"}}, 0, false)
	assertState("logged in", []*http.Cookie{sessionCookie(t, app, user.ID, false)}, 1, false)

	if err := db.Create(&model.Claim{ActivityID: activity.ID, UserID: user.ID, Quota: activity.Quota, Seq: 2}).Error; err != nil {
		t.Fatalf("create second claim: %v", err)
	}
	assertState("limit reached", []*http.Cookie{sessionCookie(t, app, user.ID, false)}, 2, true)
}
