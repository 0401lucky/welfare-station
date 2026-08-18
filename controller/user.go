package controller

import (
	"log"
	"strconv"

	"welfare/common"
	"welfare/middleware"
	"welfare/model"

	"github.com/gin-gonic/gin"
)

// GET /api/user/self — current user, binding state and real-time new-api
// balance (design.md §7). new-api balance degrades to null on failure.
func (a *App) GetSelf(c *gin.Context) {
	user := middleware.CurrentUser(c)
	if user == nil {
		common.Unauthorized(c, "未登录")
		return
	}

	var balance *int64
	if user.NewapiUserID != nil {
		nu, err := a.NewAPI.GetUser(*user.NewapiUserID)
		if err == nil {
			balance = &nu.Quota
		} else {
			// Balance is display-only; degrade gracefully.
			log.Printf("self: fetch new-api balance failed for user %d: %v", user.ID, err)
		}
	}

	common.Ok(c, gin.H{
		"user":           user,
		"bound":          user.NewapiUserID != nil,
		"newapi_balance": balance,
	})
}

// GET /api/user/grants — the current user's grant ledger (paginated).
func (a *App) GetMyGrants(c *gin.Context) {
	user := middleware.CurrentUser(c)
	if user == nil {
		common.Unauthorized(c, "未登录")
		return
	}
	page, _ := strconv.Atoi(c.DefaultQuery("page", "1"))
	pageSize, _ := strconv.Atoi(c.DefaultQuery("page_size", "20"))
	if page < 1 {
		page = 1
	}
	if pageSize < 1 || pageSize > 100 {
		pageSize = 20
	}
	var total int64
	a.DB.Model(&model.Grant{}).Where("user_id = ?", user.ID).Count(&total)
	var grants []model.Grant
	if err := a.DB.Where("user_id = ?", user.ID).Order("id desc").
		Offset((page - 1) * pageSize).Limit(pageSize).Find(&grants).Error; err != nil {
		common.InternalError(c, "读取发放记录失败")
		return
	}
	common.Ok(c, gin.H{"total": total, "page": page, "page_size": pageSize, "items": grants})
}
