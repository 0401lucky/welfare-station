package service

import (
	"encoding/json"
	"errors"
	"fmt"
	"reflect"
	"strings"
	"testing"

	"welfare/model"

	"gorm.io/gorm"
)

func feedbackUser(t *testing.T, db *gorm.DB, name string, admin bool) model.User {
	t.Helper()
	user := model.User{LinuxDOID: "id-" + name, LinuxDOName: name, DisplayName: "显示 " + name, AvatarURL: "/avatar.png", Status: 1, IsAdmin: admin}
	if err := db.Create(&user).Error; err != nil {
		t.Fatal(err)
	}
	return user
}

func createFeedback(t *testing.T, db *gorm.DB, user *model.User, category, text string, private bool) FeedbackItem {
	t.Helper()
	item, err := CreateFeedback(db, user, CreateFeedbackInput{Category: category, Content: text, IsPrivate: private})
	if err != nil {
		t.Fatal(err)
	}
	return *item
}

func TestFeedbackCreateAndTextValidation(t *testing.T) {
	db := grantDB(t)
	user := feedbackUser(t, db, "unbound", false)
	for _, category := range []string{FeedbackCategoryMessage, FeedbackCategoryPraise, FeedbackCategoryIssue, FeedbackCategorySuggestion} {
		item := createFeedback(t, db, &user, category, " \t第一行\n\n第二行 🍀 \r\n", false)
		if item.Content != "第一行\n\n第二行 🍀" || item.IsPrivate || item.IsHidden || item.ReplyCount != 0 {
			t.Fatalf("unexpected defaults/text: %+v", item)
		}
		if item.CreatedAt.IsZero() || item.UpdatedAt.IsZero() || item.Author.Name != user.DisplayName {
			t.Fatalf("missing server-owned metadata: %+v", item)
		}
		var saved model.Feedback
		if err := db.First(&saved, item.ID).Error; err != nil {
			t.Fatal(err)
		}
		if saved.UserID != user.ID || user.NewapiUserID != nil {
			t.Fatal("creating feedback must use the logged-in author without binding")
		}
		if FeedbackHasStatus(category) {
			if item.Status == nil || *item.Status != FeedbackStatusPending || saved.Status != FeedbackStatusPending {
				t.Fatalf("workflow should start pending: %+v", saved)
			}
		} else if item.Status != nil || saved.Status != "" {
			t.Fatalf("non-workflow categories must store empty and return null: %+v", saved)
		}
	}
	max := strings.Repeat("🍀", 2000)
	item := createFeedback(t, db, &user, FeedbackCategoryIssue, "\u3000"+max+"\n", true)
	if item.Content != max || !item.IsPrivate {
		t.Fatal("Unicode length should count code points after outer trimming")
	}
	for _, input := range []CreateFeedbackInput{
		{Category: "", Content: "text"},
		{Category: "unknown", Content: "text"},
		{Category: "Issue", Content: "text"},
		{Category: FeedbackCategoryMessage, Content: "\u3000\t\n"},
		{Category: FeedbackCategoryMessage, Content: strings.Repeat("🍀", 2001)},
		{Category: FeedbackCategoryMessage, Content: string([]byte{'x', 0xff})},
	} {
		_, err := CreateFeedback(db, &user, input)
		var validation FeedbackValidationError
		if !errors.As(err, &validation) {
			t.Errorf("invalid input should return validation error, got %v", err)
		}
	}
	for _, invalid := range []*model.User{nil, {ID: user.ID, Status: 2}, {ID: 0, Status: 1}} {
		if _, err := CreateFeedback(db, invalid, CreateFeedbackInput{Category: FeedbackCategoryMessage, Content: "text"}); !errors.Is(err, ErrFeedbackLoginRequired) {
			t.Fatalf("invalid author accepted: %v", err)
		}
	}
	var count int64
	if err := db.Model(&model.Feedback{}).Count(&count).Error; err != nil || count != 5 {
		t.Fatalf("invalid requests must not write rows, count=%d err=%v", count, err)
	}
}

func TestFeedbackPrivacyMatrixAndInheritedReplies(t *testing.T) {
	db := grantDB(t)
	author := feedbackUser(t, db, "author", false)
	other := feedbackUser(t, db, "other", false)
	admin := feedbackUser(t, db, "admin", true)
	type fixture struct {
		item    FeedbackItem
		replies []int64
	}
	var entries []fixture
	for _, private := range []bool{false, true} {
		for _, hidden := range []bool{false, true} {
			item := createFeedback(t, db, &author, FeedbackCategoryIssue, fmt.Sprintf("private=%t hidden=%t", private, hidden), private)
			if hidden {
				if _, err := UpdateFeedbackModeration(db, item.ID, &admin, true); err != nil {
					t.Fatal(err)
				}
				item.IsHidden = true
			}
			entry := fixture{item: item}
			for i := 0; i < 2; i++ {
				reply, err := AppendFeedbackReply(db, item.ID, &admin, fmt.Sprintf("owner reply %d", i))
				if err != nil {
					t.Fatal(err)
				}
				entry.replies = append(entry.replies, reply.ID)
			}
			entries = append(entries, entry)
		}
	}
	otherItem := createFeedback(t, db, &other, FeedbackCategoryPraise, "另一位的公开留言", false)
	createFeedback(t, db, &other, FeedbackCategoryMessage, "另一位的私密留言", true)
	wall, err := ListPublicFeedback(db, FeedbackFilters{Visibility: "private", Moderation: "hidden", Search: "private"})
	if err != nil || wall.Total != 2 || len(wall.Items) != 2 || wall.Items[0].ID != otherItem.ID || wall.Items[1].ReplyCount != 2 {
		t.Fatalf("public list filters/counts leaked or ordering wrong: %+v err=%v", wall, err)
	}
	for _, item := range wall.Items {
		if item.IsPrivate || item.IsHidden {
			t.Fatal("private/hidden item escaped onto the wall")
		}
	}
	mine, err := ListMyFeedback(db, &author, FeedbackFilters{PageSize: 2, Page: 2})
	if err != nil || mine.Total != 4 || len(mine.Items) != 2 || mine.Items[0].ID != entries[1].item.ID || mine.Items[1].ID != entries[0].item.ID {
		t.Fatalf("personal query scope/order wrong: %+v err=%v", mine, err)
	}
	adminPage, err := ListAdminFeedback(db, &admin, FeedbackFilters{})
	if err != nil || adminPage.Total != 6 {
		t.Fatalf("admin list = %+v err=%v", adminPage, err)
	}
	for _, viewer := range []*model.User{nil, &author, &other, &admin, {ID: author.ID, Status: 2}, {ID: admin.ID, IsAdmin: true, Status: 2}} {
		for _, entry := range entries {
			allowed := (!entry.item.IsPrivate && !entry.item.IsHidden) || (activeFeedbackUser(viewer) && (viewer.ID == author.ID || viewer.IsAdmin))
			detail, err := GetFeedbackDetail(db, entry.item.ID, viewer, 2, 1)
			if !allowed {
				if detail != nil || !errors.Is(err, ErrFeedbackNotFound) {
					t.Fatalf("inaccessible entry returned data: viewer=%+v detail=%+v err=%v", viewer, detail, err)
				}
				continue
			}
			if err != nil || detail.Message.ReplyCount != 2 || detail.Replies.Total != 2 || len(detail.Replies.Items) != 1 || detail.Replies.Items[0].ID != entry.replies[1] {
				t.Fatalf("authorized reply page wrong: detail=%+v err=%v", detail, err)
			}
			if detail.Message.Status == nil || *detail.Message.Status != FeedbackStatusPending {
				t.Fatal("replying must not silently change workflow status")
			}
		}
	}
	if _, err := GetFeedbackDetail(db, 999999, &admin, 1, 20); !errors.Is(err, ErrFeedbackNotFound) {
		t.Fatalf("missing and inaccessible entries must share one error: %v", err)
	}
	if _, err := ListMyFeedback(db, nil, FeedbackFilters{}); !errors.Is(err, ErrFeedbackLoginRequired) {
		t.Fatal("anonymous personal query must fail")
	}
	if _, err := ListAdminFeedback(db, &other, FeedbackFilters{}); !errors.Is(err, ErrFeedbackAdminRequired) {
		t.Fatal("non-admin admin-list query must fail")
	}
	if _, err := AppendFeedbackReply(db, entries[0].item.ID, &author, "不是站主"); !errors.Is(err, ErrFeedbackAdminRequired) {
		t.Fatal("authors cannot use owner replies")
	}
}

func TestFeedbackAdminSearchFiltersAndPagination(t *testing.T) {
	db := grantDB(t)
	admin := feedbackUser(t, db, "boss", true)
	author := feedbackUser(t, db, "literal%_!name", false)
	author.DisplayName = "青色 显示名"
	if err := db.Model(&author).Updates(map[string]any{"display_name": author.DisplayName, "newapi_username": "binding-only", "note": "note-only"}).Error; err != nil {
		t.Fatal(err)
	}
	other := feedbackUser(t, db, "plain", false)
	first := createFeedback(t, db, &author, FeedbackCategoryIssue, "100%_! 完成度", true)
	second := createFeedback(t, db, &author, FeedbackCategorySuggestion, "普通内容", false)
	createFeedback(t, db, &other, FeedbackCategoryMessage, "100ABC 完成度", false)
	if _, err := UpdateFeedbackStatus(db, first.ID, &admin, FeedbackStatusResolved); err != nil {
		t.Fatal(err)
	}
	if _, err := UpdateFeedbackModeration(db, first.ID, &admin, true); err != nil {
		t.Fatal(err)
	}
	if _, err := AppendFeedbackReply(db, first.ID, &admin, "reply-only"); err != nil {
		t.Fatal(err)
	}
	for _, test := range []struct {
		search string
		ids    []int64
	}{
		{"100%", []int64{first.ID}},
		{"100%_!", []int64{first.ID}},
		{"%_!name", []int64{second.ID, first.ID}},
		{"青色", []int64{second.ID, first.ID}},
		{"' OR 1=1 --", []int64{}},
		{"binding-only", []int64{}},
		{"note-only", []int64{}},
		{"id-literal", []int64{}},
		{"reply-only", []int64{}},
	} {
		page, err := ListAdminFeedback(db, &admin, FeedbackFilters{Search: test.search})
		if err != nil {
			t.Fatal(err)
		}
		ids := make([]int64, 0, len(page.Items))
		for _, item := range page.Items {
			ids = append(ids, item.ID)
		}
		if page.Total != int64(len(test.ids)) || !reflect.DeepEqual(ids, test.ids) {
			t.Errorf("search %q: ids=%v total=%d want=%v", test.search, ids, page.Total, test.ids)
		}
	}
	combined, err := ListAdminFeedback(db, &admin, FeedbackFilters{Search: "100%", Category: FeedbackCategoryIssue, Status: FeedbackStatusResolved, Visibility: "private", Moderation: "hidden", PageSize: 1, Page: 1})
	if err != nil || combined.Total != 1 || len(combined.Items) != 1 || combined.Items[0].ID != first.ID || combined.Items[0].UserID != author.ID || combined.Items[0].LinuxDOName != author.LinuxDOName {
		t.Fatalf("combined filters/admin projection failed: %+v err=%v", combined, err)
	}
	combined, err = ListAdminFeedback(db, &admin, FeedbackFilters{Search: "青色", PageSize: 1, Page: 2})
	if err != nil || combined.Total != 2 || len(combined.Items) != 1 || combined.Items[0].ID != first.ID {
		t.Fatalf("search pagination failed: %+v err=%v", combined, err)
	}
	incompatible, err := ListPublicFeedback(db, FeedbackFilters{Category: FeedbackCategoryMessage, Status: FeedbackStatusPending})
	if err != nil || incompatible.Total != 0 || incompatible.Items == nil {
		t.Fatalf("incompatible category/status should yield []: %+v err=%v", incompatible, err)
	}
	for _, filters := range []FeedbackFilters{
		{Category: "invalid"}, {Status: "invalid"}, {Visibility: "invalid"}, {Moderation: "invalid"},
		{Search: strings.Repeat("🍀", 101)}, {Search: string([]byte{0xff})},
	} {
		_, err := ListAdminFeedback(db, &admin, filters)
		var validation FeedbackValidationError
		if !errors.As(err, &validation) {
			t.Errorf("filters %+v: wanted validation error, got %v", filters, err)
		}
	}
	for _, filters := range []FeedbackFilters{{Page: -1, PageSize: 101}, {Page: FeedbackMaxPage + 1, PageSize: -1}, {Page: 0, PageSize: 0}} {
		page, err := ListPublicFeedback(db, filters)
		if err != nil || page.Page != 1 || page.PageSize != 20 {
			t.Errorf("bad pages must normalize safely: %+v err=%v", page, err)
		}
	}
	page, err := ListPublicFeedback(db, FeedbackFilters{Page: FeedbackMaxPage, PageSize: 100})
	if err != nil || page.Page != FeedbackMaxPage || page.PageSize != 100 || page.Total != 2 || len(page.Items) != 0 {
		t.Fatalf("maximum legal page must not overflow: %+v err=%v", page, err)
	}
}

func TestFeedbackStatusAndRestorePreserveAudience(t *testing.T) {
	db := grantDB(t)
	admin := feedbackUser(t, db, "owner", true)
	author := feedbackUser(t, db, "user", false)
	for _, private := range []bool{false, true} {
		entry := createFeedback(t, db, &author, FeedbackCategorySuggestion, "功能想法", private)
		previous := FeedbackStatusPending
		for _, status := range []string{FeedbackStatusResolved, FeedbackStatusInProgress, FeedbackStatusPending} {
			change, err := UpdateFeedbackStatus(db, entry.ID, &admin, status)
			if err != nil || !change.Changed || change.PreviousStatus != previous || change.Item.Status == nil || *change.Item.Status != status {
				t.Fatalf("workflow transition failed: %+v err=%v", change, err)
			}
			previous = status
		}
		noop, err := UpdateFeedbackStatus(db, entry.ID, &admin, previous)
		if err != nil || noop.Changed {
			t.Fatalf("unchanged status must be a no-op: %+v err=%v", noop, err)
		}
		for _, hidden := range []bool{true, false} {
			change, err := UpdateFeedbackModeration(db, entry.ID, &admin, hidden)
			if err != nil || !change.Changed || change.PreviousHidden == hidden || change.Item.IsHidden != hidden || change.Item.IsPrivate != private {
				t.Fatalf("moderation/audience changed incorrectly: %+v err=%v", change, err)
			}
			_, err = GetFeedbackDetail(db, entry.ID, nil, 1, 20)
			if (hidden || private) && !errors.Is(err, ErrFeedbackNotFound) {
				t.Fatalf("hidden/private entry became public: %v", err)
			}
			if !hidden && !private && err != nil {
				t.Fatalf("restored public entry is inaccessible: %v", err)
			}
		}
		var saved model.Feedback
		if err := db.First(&saved, entry.ID).Error; err != nil || saved.IsHidden || saved.IsPrivate != private || saved.Category != entry.Category || saved.Content != entry.Content {
			t.Fatalf("immutable fields changed or false update lost: %+v err=%v", saved, err)
		}
	}
	for _, category := range []string{FeedbackCategoryMessage, FeedbackCategoryPraise} {
		item := createFeedback(t, db, &author, category, "没有处理状态", false)
		if _, err := UpdateFeedbackStatus(db, item.ID, &admin, FeedbackStatusResolved); err == nil {
			t.Fatal("non-workflow entry accepted a status")
		}
	}
}

func TestFeedbackReplyRollsBackWithParentUpdate(t *testing.T) {
	db := grantDB(t)
	admin := feedbackUser(t, db, "admin", true)
	item := createFeedback(t, db, &admin, FeedbackCategoryIssue, "transaction", true)
	if err := db.Callback().Update().Before("gorm:update").Register("feedback:test-parent-failure", func(tx *gorm.DB) {
		if tx.Statement.Table == "w_feedbacks" {
			tx.AddError(errors.New("forced parent write failure"))
		}
	}); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Callback().Update().Remove("feedback:test-parent-failure") })
	if reply, err := AppendFeedbackReply(db, item.ID, &admin, "must roll back"); err == nil || reply != nil {
		t.Fatalf("expected a failed reply transaction, got %+v err=%v", reply, err)
	}
	var count int64
	if err := db.Model(&model.FeedbackReply{}).Count(&count).Error; err != nil || count != 0 {
		t.Fatalf("orphan reply was committed: count=%d err=%v", count, err)
	}
	var row model.Feedback
	if err := db.First(&row, item.ID).Error; err != nil || !row.UpdatedAt.Equal(item.UpdatedAt) {
		t.Fatalf("parent timestamp changed after rollback: %+v err=%v", row, err)
	}
}

func TestFeedbackProjectionAndMissingAuthors(t *testing.T) {
	db := grantDB(t)
	author := feedbackUser(t, db, "author", false)
	admin := feedbackUser(t, db, "admin", true)
	if err := db.Model(&author).Updates(map[string]any{"note": "private-note", "linux_do_id": "secret-id", "trust_level": 4, "newapi_username": "secret-binding"}).Error; err != nil {
		t.Fatal(err)
	}
	item := createFeedback(t, db, &author, FeedbackCategoryMessage, "visible", false)
	if _, err := AppendFeedbackReply(db, item.ID, &admin, "owner reply"); err != nil {
		t.Fatal(err)
	}
	detail, err := GetFeedbackDetail(db, item.ID, &admin, 1, 20)
	if err != nil {
		t.Fatal(err)
	}
	raw, err := json.Marshal(detail)
	if err != nil {
		t.Fatal(err)
	}
	for _, forbidden := range []string{"user_id", "admin_user_id", "linux_do_id", "linux_do_name", "trust_level", "newapi", "is_admin", "private-note", "secret-id", "secret-binding"} {
		if strings.Contains(string(raw), forbidden) {
			t.Errorf("public projection contains %q: %s", forbidden, raw)
		}
	}
	if !strings.Contains(string(raw), `"status":null`) {
		t.Fatal("non-workflow status must be explicit JSON null")
	}
	// Simulate a missing profile on disposable data; neither entry nor reply
	// may disappear, and the fallback must not reveal numeric identifiers.
	if err := db.Delete(&author).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Delete(&admin).Error; err != nil {
		t.Fatal(err)
	}
	detail, err = GetFeedbackDetail(db, item.ID, nil, 1, 20)
	if err != nil || detail.Message.Author.Name != "小站用户" || detail.Message.Author.AvatarURL != "" || detail.Replies.Items[0].Author.Name != "小站用户" || detail.Replies.Items[0].Author.AvatarURL != "" {
		t.Fatalf("missing profile fallback failed: %+v err=%v", detail, err)
	}
}
