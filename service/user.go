package service

import (
	"errors"
	"strconv"
	"time"

	"welfare/model"

	"gorm.io/gorm"
)

// UpsertUserFromOAuth creates or updates the welfare-side user from a LinuxDO
// profile, refreshing trust level and admin flag from the whitelist.
func UpsertUserFromOAuth(db *gorm.DB, o *OAuthUser, isAdmin bool) (*model.User, error) {
	now := time.Now()
	linuxDOID := strconv.Itoa(o.ID)
	var user model.User
	err := db.Where("linux_do_id = ?", linuxDOID).First(&user).Error
	isNew := false
	if errors.Is(err, gorm.ErrRecordNotFound) {
		isNew = true
		user = model.User{
			LinuxDOID:   linuxDOID,
			LinuxDOName: o.Username,
			DisplayName: o.Name,
			TrustLevel:  o.TrustLevel,
			Status:      1,
		}
	} else if err != nil {
		return nil, err
	} else {
		user.LinuxDOName = o.Username
		user.DisplayName = o.Name
		user.TrustLevel = o.TrustLevel
	}

	user.IsAdmin = isAdmin
	user.LastLoginAt = &now

	if isNew {
		if err := db.Create(&user).Error; err != nil {
			return nil, err
		}
	} else {
		if err := db.Save(&user).Error; err != nil {
			return nil, err
		}
	}
	return &user, nil
}

// BindToNewAPI matches the user to a new-api account by linux_do_id
// (design.md §4.1) and writes the binding when a match is found and the
// account is not already claimed by another welfare user. Returns
// (boundUser, bound bool, err).
func BindToNewAPI(db *gorm.DB, client *NewAPIClient, user *model.User) (*model.User, bool, error) {
	if user.NewapiUserID != nil {
		return user, true, nil
	}
	nu, err := client.GetUserByLinuxDOId(user.LinuxDOID)
	if err != nil {
		// Treat "用户不存在" and network errors the same from the caller's
		// perspective: the user stays unbound and can retry later.
		return user, false, nil
	}

	// Check the matched account isn't already bound to another welfare user.
	var holder model.User
	err = db.Where("newapi_user_id = ?", nu.ID).First(&holder).Error
	if err == nil && holder.ID != user.ID {
		return user, false, errors.New("该 new-api 账号已被其他福利站账号绑定")
	}
	if err != nil && !errors.Is(err, gorm.ErrRecordNotFound) {
		return user, false, err
	}

	user.NewapiUserID = int64Ptr(nu.ID)
	user.NewapiUsername = nu.Username
	if err := db.Save(user).Error; err != nil {
		return user, false, err
	}
	return user, true, nil
}

func int64Ptr(i int64) *int64 { return &i }
