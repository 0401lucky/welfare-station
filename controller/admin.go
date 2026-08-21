package controller

import (
	"errors"
	"net/http"
	"strconv"
	"time"

	"welfare/common"
	"welfare/model"
	"welfare/service"

	"github.com/gin-gonic/gin"
)

// GET /api/admin/dashboard — basic stats (R4.6).
func (a *App) AdminDashboard(c *gin.Context) {
	now := time.Now()
	tz := "Asia/Shanghai"
	if cfg, err := service.GetCheckinConfig(a.DB); err == nil && cfg.Timezone != "" {
		tz = cfg.Timezone
	}
	todayStr := service.TodayStr(tz, now)

	var todayCheckins int64
	a.DB.Model(&model.Checkin{}).Where("checkin_date = ?", todayStr).Count(&todayCheckins)
	var todayClaims int64
	a.DB.Model(&model.Claim{}).Where("created_at >= ?", startOfToday(now)).Count(&todayClaims)
	var totalGrants int64
	a.DB.Model(&model.Grant{}).Count(&totalGrants)
	var totalQuota int64
	a.DB.Model(&model.Grant{}).Where("status = ?", service.GrantStatusSuccess).Select("COALESCE(SUM(quota),0)").Scan(&totalQuota)
	var pending int64
	a.DB.Model(&model.Grant{}).Where("status = ?", service.GrantStatusPending).Count(&pending)
	var failed int64
	a.DB.Model(&model.Grant{}).Where("status = ?", service.GrantStatusFailed).Count(&failed)

	common.Ok(c, gin.H{
		"today_checkins": todayCheckins,
		"today_claims":   todayClaims,
		"total_grants":   totalGrants,
		"total_quota":    totalQuota,
		"failed_grants":  failed,
		"pending_grants": pending,
		"quota_per_unit": a.Config.QuotaPerUnit,
	})
}

func startOfToday(now time.Time) time.Time {
	y, m, d := now.Date()
	return time.Date(y, m, d, 0, 0, 0, 0, now.Location())
}

// GET/PUT /api/admin/checkin-config — read/write check-in rules (R4.2).
func (a *App) AdminGetCheckinConfig(c *gin.Context) {
	cfg, err := service.GetCheckinConfig(a.DB)
	if err != nil {
		common.InternalError(c, "读取签到配置失败")
		return
	}
	common.Ok(c, cfg)
}

func (a *App) AdminPutCheckinConfig(c *gin.Context) {
	var body service.CheckinConfig
	if err := c.ShouldBindJSON(&body); err != nil {
		common.BadRequest(c, "JSON 格式错误")
		return
	}
	if err := service.SaveCheckinConfig(a.DB, &body); err != nil {
		common.BadRequest(c, err.Error())
		return
	}
	common.Ok(c, body)
}

// GET/POST /api/admin/activities — list (with claims) / create (R4.3).
func (a *App) AdminListActivities(c *gin.Context) {
	var acts []model.Activity
	if err := a.DB.Order("id desc").Find(&acts).Error; err != nil {
		common.InternalError(c, "读取活动失败")
		return
	}
	common.Ok(c, acts)
}

func (a *App) AdminCreateActivity(c *gin.Context) {
	var body struct {
		Title         string `json:"title"`
		Description   string `json:"description"`
		Quota         int64  `json:"quota"`
		TotalCount    int    `json:"total_count"`
		PerUserLimit  int    `json:"per_user_limit"`
		MinTrustLevel int    `json:"min_trust_level"`
		StartAt       string `json:"start_at"`
		EndAt         string `json:"end_at"`
		Status        int    `json:"status"`
	}
	if err := c.ShouldBindJSON(&body); err != nil {
		common.BadRequest(c, "JSON 格式错误")
		return
	}
	startAt, err := time.Parse(time.RFC3339, body.StartAt)
	if err != nil {
		common.BadRequest(c, "start_at 需为 RFC3339 时间")
		return
	}
	endAt, err := time.Parse(time.RFC3339, body.EndAt)
	if err != nil {
		common.BadRequest(c, "end_at 需为 RFC3339 时间")
		return
	}
	if body.Title == "" || body.Quota <= 0 || body.TotalCount <= 0 {
		common.BadRequest(c, "title/quota/total_count 必填且需为正数")
		return
	}
	if endAt.Before(startAt) {
		common.BadRequest(c, "结束时间需晚于开始时间")
		return
	}
	if body.PerUserLimit <= 0 {
		body.PerUserLimit = 1
	}
	if body.MinTrustLevel < 0 {
		body.MinTrustLevel = 0
	}
	st := body.Status
	if st != service.ActivityStatusOn && st != service.ActivityStatusOff {
		st = service.ActivityStatusOn
	}
	a2 := model.Activity{
		Title:         body.Title,
		Description:   body.Description,
		Quota:         body.Quota,
		TotalCount:    body.TotalCount,
		PerUserLimit:  body.PerUserLimit,
		MinTrustLevel: body.MinTrustLevel,
		StartAt:       startAt,
		EndAt:         endAt,
		Status:        st,
	}
	if err := a.DB.Create(&a2).Error; err != nil {
		common.InternalError(c, "创建活动失败")
		return
	}
	common.Ok(c, a2)
}

// PUT/DELETE /api/admin/activities/:id — update / delete (R4.3).
func (a *App) AdminUpdateActivity(c *gin.Context) {
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		common.BadRequest(c, "无效的活动 ID")
		return
	}
	var act model.Activity
	if err := a.DB.First(&act, id).Error; err != nil {
		common.Fail(c, http.StatusNotFound, "活动不存在")
		return
	}
	var body struct {
		Title         string `json:"title"`
		Description   string `json:"description"`
		Quota         int64  `json:"quota"`
		TotalCount    int    `json:"total_count"`
		PerUserLimit  int    `json:"per_user_limit"`
		MinTrustLevel int    `json:"min_trust_level"`
		StartAt       string `json:"start_at"`
		EndAt         string `json:"end_at"`
		Status        int    `json:"status"`
	}
	if err := c.ShouldBindJSON(&body); err != nil {
		common.BadRequest(c, "JSON 格式错误")
		return
	}
	startAt, err := time.Parse(time.RFC3339, body.StartAt)
	if err != nil {
		common.BadRequest(c, "start_at 需为 RFC3339 时间")
		return
	}
	endAt, err := time.Parse(time.RFC3339, body.EndAt)
	if err != nil {
		common.BadRequest(c, "end_at 需为 RFC3339 时间")
		return
	}
	if body.Title == "" || body.Quota <= 0 || body.TotalCount <= 0 {
		common.BadRequest(c, "title/quota/total_count 必填且需为正数")
		return
	}
	if endAt.Before(startAt) {
		common.BadRequest(c, "结束时间需晚于开始时间")
		return
	}
	// 总份数不得少于已领份数，否则剩余库存会算成负数。
	if body.TotalCount < act.ClaimedCount {
		common.BadRequest(c, "总份数不能小于已领取份数 "+strconv.Itoa(act.ClaimedCount))
		return
	}
	if body.PerUserLimit <= 0 {
		body.PerUserLimit = 1
	}
	if body.MinTrustLevel < 0 {
		body.MinTrustLevel = 0
	}
	// 编辑路径必须能保存为「下架」，非法值一律拒绝而非兜底成上架。
	if body.Status != service.ActivityStatusOn && body.Status != service.ActivityStatusOff {
		common.BadRequest(c, "status 只能为上架或下架")
		return
	}
	// 只更新白名单字段：claimed_count / id / created_at 不受请求体影响。
	updates := model.Activity{
		Title:         body.Title,
		Description:   body.Description,
		Quota:         body.Quota,
		TotalCount:    body.TotalCount,
		PerUserLimit:  body.PerUserLimit,
		MinTrustLevel: body.MinTrustLevel,
		StartAt:       startAt,
		EndAt:         endAt,
		Status:        body.Status,
	}
	if err := a.DB.Model(&act).
		Select("title", "description", "quota", "total_count", "per_user_limit", "min_trust_level", "start_at", "end_at", "status").
		Updates(updates).Error; err != nil {
		common.InternalError(c, "更新活动失败")
		return
	}
	a.DB.First(&act, id)
	common.Ok(c, act)
}

func (a *App) AdminDeleteActivity(c *gin.Context) {
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		common.BadRequest(c, "无效的活动 ID")
		return
	}
	if err := a.DB.Delete(&model.Activity{}, id).Error; err != nil {
		common.InternalError(c, "删除活动失败")
		return
	}
	common.Ok(c, gin.H{"deleted": true})
}

// GET /api/admin/activities/:id/claims — claim detail (R4.3).
func (a *App) AdminListClaims(c *gin.Context) {
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		common.BadRequest(c, "无效的活动 ID")
		return
	}
	var claims []model.Claim
	if err := a.DB.Where("activity_id = ?", id).Order("id desc").Find(&claims).Error; err != nil {
		common.InternalError(c, "读取领取明细失败")
		return
	}
	common.Ok(c, claims)
}

// GET /api/admin/grants — grant ledger with filters (R4.4).
func (a *App) AdminListGrants(c *gin.Context) {
	q := a.DB.Model(&model.Grant{})
	if s := c.Query("status"); s != "" {
		q = q.Where("status = ?", s)
	}
	if t := c.Query("type"); t != "" {
		q = q.Where("type = ?", t)
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
	q.Count(&total)
	var grants []model.Grant
	if err := q.Order("id desc").Offset((page - 1) * pageSize).Limit(pageSize).Find(&grants).Error; err != nil {
		common.InternalError(c, "读取流水失败")
		return
	}
	common.Ok(c, gin.H{"total": total, "page": page, "page_size": pageSize, "items": grants,
		// 前端据此判断某条失败流水是否已用尽自动重试预算(需人工介入)。
		"auto_retry_enabled":      a.Config.AutoRetryEnabled,
		"auto_retry_max_attempts": a.Config.AutoRetryMaxAttempts})
}

// POST /api/admin/grants/:id/retry — retry a failed grant (R4.4 / R5.3).
func (a *App) AdminRetryGrant(c *gin.Context) {
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		common.BadRequest(c, "无效的流水 ID")
		return
	}
	grants := service.NewGrantService(a.DB, a.NewAPI)
	if err := grants.RetryManual(id); err != nil {
		if errors.Is(err, service.ErrNotFailed) {
			common.BadRequest(c, "该流水不在可重试状态")
			return
		}
		// A failed retry still reports friendly data with the updated grant.
		var g model.Grant
		if err2 := a.DB.First(&g, id).Error; err2 == nil {
			common.FailData(c, http.StatusOK, "重试发放仍失败,请检查 new-api", g)
			return
		}
		common.InternalError(c, "重试失败")
		return
	}
	var g model.Grant
	a.DB.First(&g, id)
	common.Ok(c, g)
}

// POST /api/admin/grants/manual — manual payout (R4.5).
func (a *App) AdminManualGrant(c *gin.Context) {
	var body struct {
		UserID       *int64 `json:"user_id"`        // welfare-station user id
		NewapiUserID *int64 `json:"newapi_user_id"` // OR new-api user id
		Quota        *int64 `json:"quota"`
		Remark       string `json:"remark"`
	}
	if err := c.ShouldBindJSON(&body); err != nil {
		common.BadRequest(c, "JSON 格式错误")
		return
	}
	if body.Quota == nil || *body.Quota <= 0 || *body.Quota > a.Config.MaxGrantQuota {
		common.BadRequest(c, "quota 必须大于 0 且不超过上限 "+strconv.FormatInt(a.Config.MaxGrantQuota, 10))
		return
	}

	var wu model.User
	var newapiID int64
	switch {
	case body.UserID != nil && body.NewapiUserID != nil:
		common.BadRequest(c, "user_id 与 newapi_user_id 二选一")
		return
	case body.UserID != nil:
		if err := a.DB.First(&wu, *body.UserID).Error; err != nil {
			common.Fail(c, http.StatusNotFound, "福利站用户不存在")
			return
		}
		if wu.NewapiUserID == nil {
			common.BadRequest(c, "该福利站用户未绑定 new-api")
			return
		}
		newapiID = *wu.NewapiUserID
	case body.NewapiUserID != nil:
		newapiID = *body.NewapiUserID
		// Ensure the new-api account exists before issuing the payout.
		if _, err := a.NewAPI.GetUser(newapiID); err != nil {
			common.BadRequest(c, "new-api 用户不存在或查询失败")
			return
		}
		wu.ID = 0 // no welfare-side record for an anonymous new-api id payout
	default:
		common.BadRequest(c, "请提供 user_id 或 newapi_user_id")
		return
	}

	grant := &model.Grant{
		UserID:       wu.ID,
		NewapiUserID: newapiID,
		Type:         "manual",
		RefID:        service.NewManualRefID(),
		Quota:        *body.Quota,
	}
	grants := service.NewGrantService(a.DB, a.NewAPI)
	if err := grants.Grant(grant); err != nil {
		common.InternalError(c, "发放失败:"+err.Error())
		return
	}
	if grant.Status == service.GrantStatusFailed {
		common.FailData(c, http.StatusOK, "发放到 new-api 失败,流水已记录可重试", grant)
		return
	}
	common.Ok(c, grant)
}

// GET /api/admin/users — welfare users + status toggle (R4.1, R7).
func (a *App) AdminListUsers(c *gin.Context) {
	q := a.DB.Model(&model.User{})
	if kw := c.Query("keyword"); kw != "" {
		like := "%" + kw + "%"
		q = q.Where("linux_do_name LIKE ? OR linux_do_id LIKE ? OR newapi_username LIKE ?", like, like, like)
	}
	var users []model.User
	if err := q.Order("id desc").Limit(100).Find(&users).Error; err != nil {
		common.InternalError(c, "读取用户失败")
		return
	}
	common.Ok(c, users)
}

// PUT /api/admin/users/:id/status — ban / unban a welfare user (R4.1).
func (a *App) AdminToggleUserStatus(c *gin.Context) {
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		common.BadRequest(c, "无效的用户 ID")
		return
	}
	var body struct {
		Status int `json:"status"` // 1 normal / 2 banned
	}
	if err := c.ShouldBindJSON(&body); err != nil {
		common.BadRequest(c, "JSON 格式错误")
		return
	}
	if body.Status != 1 && body.Status != 2 {
		common.BadRequest(c, "status 只能为 1(正常) 或 2(封禁)")
		return
	}
	res := a.DB.Model(&model.User{}).Where("id = ?", id).Update("status", body.Status)
	if res.Error != nil {
		common.InternalError(c, "更新用户状态失败")
		return
	}
	if res.RowsAffected == 0 {
		common.Fail(c, http.StatusNotFound, "用户不存在")
		return
	}
	common.Ok(c, gin.H{"id": id, "status": body.Status})
}

// GET/PUT /api/admin/game-config — 读/写游戏注册表与预算池配置(R4.2 / R4.3)。
func (a *App) AdminGetGameConfig(c *gin.Context) {
	cfg, err := service.GetGameConfig(a.DB)
	if err != nil {
		common.InternalError(c, "读取游戏配置失败")
		return
	}
	common.Ok(c, cfg)
}

func (a *App) AdminPutGameConfig(c *gin.Context) {
	var body service.GameConfig
	if err := c.ShouldBindJSON(&body); err != nil {
		common.BadRequest(c, "JSON 格式错误")
		return
	}
	// 校验与归一化(档位按 tile 升序、时区回落、reward_type 兜底)全在
	// SaveGameConfig 里就地完成,这里不重复实现,失败信息原样透出给站长。
	if err := service.SaveGameConfig(a.DB, &body, a.Config.MaxGrantQuota); err != nil {
		common.BadRequest(c, err.Error())
		return
	}
	// 回的是归一化之后的 body,前端拿到的就是落库的那一份。
	common.Ok(c, body)
}

// budgetScopeView 是后台预算页里一个池的展示数据:上限来自配置,用量来自
// w_daily_budgets,两边在这里合并。
type budgetScopeView struct {
	Scope     string `json:"scope"`
	Enabled   bool   `json:"enabled"`
	Daily     int64  `json:"daily"`
	UsedToday int64  `json:"used_today"`
	Remaining int64  `json:"remaining"`
}

// GET /api/admin/budgets?days=7 — 各池今日用量 + 近 N 日曲线(R4.4)。
func (a *App) AdminBudgets(c *gin.Context) {
	cfg, err := service.GetGameConfig(a.DB)
	if err != nil {
		common.InternalError(c, "读取游戏配置失败")
		return
	}
	// days 非法(非数字或小于 1)一律回落 7;上界由 BudgetUsage 自己夹到 90。
	days, convErr := strconv.Atoi(c.DefaultQuery("days", "7"))
	if convErr != nil || days < 1 {
		days = 7
	}
	now := time.Now()
	history, err := service.BudgetUsage(a.DB, cfg.Timezone, days, now)
	if err != nil {
		common.InternalError(c, "读取预算用量失败")
		return
	}
	// history 按日期升序,最后一项即今日。
	usedToday := map[string]int64{}
	if len(history) > 0 {
		usedToday = history[len(history)-1].Used
	}

	scopes := make([]budgetScopeView, 0, len(service.BudgetScopes))
	for _, scope := range service.BudgetScopes {
		rule := cfg.Budgets[scope] // 配置里缺这个池就取零值:未开启、预算 0
		used := usedToday[scope]
		// 未开启的池不报剩余额度(前端按「未开启」渲染);已开启时剩余不给负数。
		var remaining int64
		if rule.Enabled && rule.Daily > used {
			remaining = rule.Daily - used
		}
		scopes = append(scopes, budgetScopeView{
			Scope:     scope,
			Enabled:   rule.Enabled,
			Daily:     rule.Daily,
			UsedToday: used,
			Remaining: remaining,
		})
	}

	common.Ok(c, gin.H{
		"timezone": cfg.Timezone,
		"today":    service.TodayStr(cfg.Timezone, now),
		"scopes":   scopes,
		"history":  history,
	})
}
