package service

import (
	"errors"

	"welfare/model"

	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

// All feedback projections (including V1 and image bytes) use these predicates.
// The public wall deliberately passes nil, even for an authenticated admin.
func feedbackParentScope(query *gorm.DB, viewer *model.User) *gorm.DB {
	if !activeFeedbackUser(viewer) {
		return query.Where("is_private = ? AND is_hidden = ?", false, false)
	}
	if !viewer.IsAdmin {
		return query.Where("(user_id = ? OR (is_private = ? AND is_hidden = ?))", viewer.ID, false, false)
	}
	return query
}

func feedbackReplyScope(query *gorm.DB, viewer *model.User) *gorm.DB {
	if !activeFeedbackUser(viewer) {
		return query.Where("is_hidden = ?", false)
	}
	if !viewer.IsAdmin {
		return query.Where("(is_hidden = ? OR admin_user_id = ?)", false, viewer.ID)
	}
	return query
}

// Re-read identity inside the transaction after upload/decoding. A snapshot of
// the account in the auth middleware cannot authorize a later publication.
func liveFeedbackUser(db *gorm.DB, identity *model.User, required, admin, lock bool) (*model.User, error) {
	if !activeFeedbackUser(identity) {
		if required {
			return nil, ErrFeedbackLoginRequired
		}
		return nil, nil
	}
	var user model.User
	query := db
	if lock {
		query = query.Clauses(clause.Locking{Strength: "UPDATE"})
	}
	err := query.First(&user, identity.ID).Error
	if errors.Is(err, gorm.ErrRecordNotFound) || (err == nil && !activeFeedbackUser(&user)) {
		if required {
			return nil, ErrFeedbackLoginRequired
		}
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if admin && !user.IsAdmin {
		return nil, ErrFeedbackAdminRequired
	}
	return &user, nil
}
