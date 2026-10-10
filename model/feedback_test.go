package model

import (
	"reflect"
	"testing"
)

func TestFeedbackMigrationPreservesDataAndIndexes(t *testing.T) {
	db := testDB(t)
	if err := Migrate(db); err != nil {
		t.Fatal(err)
	}
	entry := Feedback{UserID: 42, Category: "issue", Content: "保留私密留言", IsPrivate: true, IsHidden: true, Status: "pending"}
	if err := db.Create(&entry).Error; err != nil {
		t.Fatal(err)
	}
	reply := FeedbackReply{FeedbackID: entry.ID, UserID: 7, Content: "保留回复"}
	if err := db.Create(&reply).Error; err != nil {
		t.Fatal(err)
	}
	if err := Migrate(db); err != nil {
		t.Fatal(err)
	}
	var saved Feedback
	if err := db.First(&saved, entry.ID).Error; err != nil {
		t.Fatal(err)
	}
	if saved.Content != entry.Content || !saved.IsPrivate || !saved.IsHidden || saved.Status != entry.Status || !saved.CreatedAt.Equal(entry.CreatedAt) || !saved.UpdatedAt.Equal(entry.UpdatedAt) {
		t.Fatalf("migration changed an existing entry: %+v", saved)
	}
	var savedReply FeedbackReply
	if err := db.First(&savedReply, reply.ID).Error; err != nil || savedReply.Content != reply.Content || savedReply.FeedbackID != entry.ID {
		t.Fatalf("migration changed a reply: %+v, err=%v", savedReply, err)
	}
	for _, test := range []struct {
		table, index string
		columns      []string
	}{
		{"w_feedbacks", "idx_feedback_public", []string{"is_private", "is_hidden", "id"}},
		{"w_feedbacks", "idx_feedback_author", []string{"user_id", "id"}},
		{"w_feedbacks", "idx_feedback_category_status", []string{"category", "status"}},
		{"w_feedback_replies", "idx_feedback_reply_parent", []string{"feedback_id", "id"}},
	} {
		if !db.Migrator().HasIndex(test.table, test.index) {
			t.Errorf("missing index %s", test.index)
			continue
		}
		var info []struct{ Name string }
		if err := db.Raw("PRAGMA index_info('" + test.index + "')").Scan(&info).Error; err != nil {
			t.Fatal(err)
		}
		columns := make([]string, 0, len(info))
		for _, column := range info {
			columns = append(columns, column.Name)
		}
		if !reflect.DeepEqual(columns, test.columns) {
			t.Errorf("%s columns = %v, want %v", test.index, columns, test.columns)
		}
	}
}
