package controller

import (
	"encoding/csv"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	"welfare/common"
	"welfare/model"
	"welfare/service"

	"github.com/gin-gonic/gin"
	"gorm.io/gorm"
)

// AdminGrantUser 是后台流水中关联的福利站用户投影。
// 流水仍保留原有顶层 user_id/newapi_user_id 字段，user 仅补充可读的用户资料。
type AdminGrantUser struct {
	ID             int64  `json:"id"`
	LinuxDOID      string `json:"linux_do_id"`
	LinuxDOName    string `json:"linux_do_name"`
	DisplayName    string `json:"display_name"`
	NewapiUserID   *int64 `json:"newapi_user_id"`
	NewapiUsername string `json:"newapi_username,omitempty"`
}

// AdminGrantItem 保持 model.Grant 的兼容字段，并附带关联用户。
type AdminGrantItem struct {
	model.Grant
	User *AdminGrantUser `json:"user,omitempty"`
}

// escapeLikeLiteral 将搜索词中的 LIKE 通配符按字面量处理。
func escapeLikeLiteral(value string) string {
	value = strings.ReplaceAll(value, `\`, `\`+`\`)
	value = strings.ReplaceAll(value, `%`, `\%`)
	return strings.ReplaceAll(value, `_`, `\_`)
}

// sumByName 承接「按某个维度分组求和」的查询结果。
// 别名不用 key:它在 MySQL 里是保留字,加反引号才能用,不值得。
type sumByName struct {
	Name  string
	Total int64
}

// scanSumByName 把分组求和结果铺平成查找表,缺的组按 0 处理,前端不必区分
// 「今天这个来源没发过」和「没有这个来源」。
func scanSumByName(rows []sumByName) map[string]int64 {
	out := make(map[string]int64, len(rows))
	for _, r := range rows {
		out[r.Name] = r.Total
	}
	return out
}

// startOfTodayIn 返回**配置时区**当日零点。
//
// 不能用服务器本地时区:签到/抽奖/对局都按配置时区的 date 列统计,而活动领取与
// 发放流水只有 created_at 时间戳。两边口径不一致时,仪表盘上「今日签到」和
// 「今日领取」会分属不同的一天,数字对不上却看不出原因。
func startOfTodayIn(tz string, now time.Time) time.Time {
	loc := service.LoadLocationOr(tz)
	l := now.In(loc)
	return time.Date(l.Year(), l.Month(), l.Day(), 0, 0, 0, 0, loc)
}

// checkinTimezone 返回签到配置的时区,读不到时回落默认值。后台所有「今日」口径都以它为准。
func (a *App) checkinTimezone() string {
	if cfg, err := service.GetCheckinConfig(a.DB); err == nil && cfg.Timezone != "" {
		return cfg.Timezone
	}
	return service.DefaultTimezone
}

// GET /api/admin/dashboard — 运营概览(R4.6)。
//
// 分四组:今日各玩法的参与与中奖、今日发放额度(按来源与按额度类型)、
// 累计与流水健康、用户规模。所有「今日」一律以配置时区的日界为准。
func (a *App) AdminDashboard(c *gin.Context) {
	now := time.Now()
	tz := a.checkinTimezone()
	todayStr := service.TodayStr(tz, now)
	dayStart := startOfTodayIn(tz, now)

	// ---- 今日:签到 ----
	var todayCheckins int64
	a.DB.Model(&model.Checkin{}).Where("checkin_date = ?", todayStr).Count(&todayCheckins)

	// ---- 今日:抽奖(盲盒)----
	// 一人一天只能抽一次,所以「抽奖记录数 = 参与人数」。
	var todayDraws, todayDrawWinners, todayDrawJackpots int64
	a.DB.Model(&model.Draw{}).Where("draw_date = ?", todayStr).Count(&todayDraws)
	// 中奖 = 真的发出了额度。命中奖励档但当日奖池已空(reason=over_site_budget)
	// 的那些 quota 是 0,不算中奖,否则会把「没发出去」报成中奖。
	a.DB.Model(&model.Draw{}).Where("draw_date = ? AND quota > 0", todayStr).Count(&todayDrawWinners)
	a.DB.Model(&model.Draw{}).
		Where("draw_date = ? AND quota > 0 AND quota_type = ?", todayStr, service.QuotaTypePermanent).
		Count(&todayDrawJackpots)

	// ---- 今日:小游戏 ----
	var todayGamePlays, todayGameRewards int64
	a.DB.Model(&model.GamePlay{}).Where("play_date = ?", todayStr).Count(&todayGamePlays)
	a.DB.Model(&model.GamePlay{}).Where("play_date = ? AND quota > 0", todayStr).Count(&todayGameRewards)

	// ---- 今日:活动领取 ----
	var todayClaims int64
	a.DB.Model(&model.Claim{}).Where("created_at >= ?", dayStart).Count(&todayClaims)

	// ---- 今日发放额度 ----
	// 一律以 w_grants 为准(唯一的发放事实来源),且只统计 success:
	// 失败/待重试的那笔钱还没到用户手里,计进「已发放」会虚高。
	var byType []sumByName
	a.DB.Model(&model.Grant{}).
		Select("type as name, COALESCE(SUM(quota),0) as total").
		Where("status = ? AND created_at >= ?", service.GrantStatusSuccess, dayStart).
		Group("type").Scan(&byType)
	quotaBySource := scanSumByName(byType)

	var byKind []sumByName
	a.DB.Model(&model.Grant{}).
		Select("quota_type as name, COALESCE(SUM(quota),0) as total").
		Where("status = ? AND created_at >= ?", service.GrantStatusSuccess, dayStart).
		Group("quota_type").Scan(&byKind)
	quotaByKind := scanSumByName(byKind)

	var todayQuota int64
	for _, v := range quotaBySource {
		todayQuota += v
	}

	// ---- 累计与流水健康 ----
	var totalGrants, totalQuota, pending, failed int64
	a.DB.Model(&model.Grant{}).Count(&totalGrants)
	a.DB.Model(&model.Grant{}).Where("status = ?", service.GrantStatusSuccess).
		Select("COALESCE(SUM(quota),0)").Scan(&totalQuota)
	a.DB.Model(&model.Grant{}).Where("status = ?", service.GrantStatusPending).Count(&pending)
	a.DB.Model(&model.Grant{}).Where("status = ?", service.GrantStatusFailed).Count(&failed)

	// ---- 用户规模 ----
	var totalUsers, boundUsers, newUsersToday int64
	a.DB.Model(&model.User{}).Count(&totalUsers)
	a.DB.Model(&model.User{}).Where("newapi_user_id IS NOT NULL").Count(&boundUsers)
	a.DB.Model(&model.User{}).Where("created_at >= ?", dayStart).Count(&newUsersToday)

	common.Ok(c, gin.H{
		"today":    todayStr,
		"timezone": tz,

		// 兼容既有字段名,前端旧版本不会因为本次扩展而读到 undefined。
		"today_checkins": todayCheckins,
		"today_claims":   todayClaims,
		"total_grants":   totalGrants,
		"total_quota":    totalQuota,
		"failed_grants":  failed,
		"pending_grants": pending,
		"quota_per_unit": a.Config.QuotaPerUnit,

		// 抽奖
		"today_draws":         todayDraws,
		"today_draw_winners":  todayDrawWinners,
		"today_draw_jackpots": todayDrawJackpots,

		// 小游戏
		"today_game_plays":   todayGamePlays,
		"today_game_rewards": todayGameRewards,

		// 今日发放额度
		"today_quota":           todayQuota,
		"today_quota_by_source": quotaBySource,
		"today_quota_by_kind":   quotaByKind,

		// 用户
		"total_users":     totalUsers,
		"bound_users":     boundUsers,
		"new_users_today": newUsersToday,
	})
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

// GET/PUT /api/admin/site-notice — 站点公告(纯文本,≤ 500 字,空串即隐藏)。
func (a *App) AdminGetSiteNotice(c *gin.Context) {
	common.Ok(c, gin.H{"notice": service.GetSiteNotice(a.DB)})
}

func (a *App) AdminPutSiteNotice(c *gin.Context) {
	var body struct {
		Notice string `json:"notice"`
	}
	if err := c.ShouldBindJSON(&body); err != nil {
		common.BadRequest(c, "JSON 格式错误")
		return
	}
	saved, err := service.PutSiteNotice(a.DB, body.Notice)
	if err != nil {
		common.BadRequest(c, err.Error())
		return
	}
	// TODO(audit): admin-insights 落地后在此记录审计日志(action=site_notice.update)。
	common.Ok(c, gin.H{"notice": saved})
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

// errGrantSearchTooLong 让列表与导出对超长搜索词给出同一句提示。
var errGrantSearchTooLong = errors.New("search 不能超过 128 个字符")

// buildGrantQuery 按 status / type / search 组装流水筛选,列表与 CSV 导出共用,
// 保证「导出的就是筛出来的」。不含排序与分页。
func (a *App) buildGrantQuery(c *gin.Context) (*gorm.DB, error) {
	q := a.DB.Model(&model.Grant{})
	if s := c.Query("status"); s != "" {
		q = q.Where("status = ?", s)
	}
	if t := c.Query("type"); t != "" {
		q = q.Where("type = ?", t)
	}
	if search := strings.TrimSpace(c.Query("search")); search != "" {
		if len(search) > 128 {
			return nil, errGrantSearchTooLong
		}
		like := "%" + escapeLikeLiteral(search) + "%"
		userQuery := a.DB.Model(&model.User{}).
			Select("id").
			Where("linux_do_id LIKE ? ESCAPE '\\' OR linux_do_name LIKE ? ESCAPE '\\' OR display_name LIKE ? ESCAPE '\\' OR newapi_username LIKE ? ESCAPE '\\'", like, like, like, like)
		if numericID, err := strconv.ParseInt(search, 10, 64); err == nil {
			userQuery = userQuery.Or("id = ? OR newapi_user_id = ?", numericID, numericID)
			q = q.Where("(user_id IN (?) OR user_id = ? OR type = ? OR ref_id = ? OR newapi_user_id = ?)", userQuery, numericID, search, numericID, numericID)
		} else {
			q = q.Where("(user_id IN (?) OR type LIKE ? ESCAPE '\\')", userQuery, like)
		}
	}
	return q, nil
}

// adminPageParams 解析后台列表共用的 page / page_size:非法或越界一律回落默认值。
func adminPageParams(c *gin.Context) (page, pageSize int) {
	page, _ = strconv.Atoi(c.DefaultQuery("page", "1"))
	pageSize, _ = strconv.Atoi(c.DefaultQuery("page_size", "20"))
	if page < 1 {
		page = 1
	}
	if pageSize < 1 || pageSize > 100 {
		pageSize = 20
	}
	return page, pageSize
}

// GET /api/admin/grants — grant ledger with filters (R4.4).
func (a *App) AdminListGrants(c *gin.Context) {
	q, err := a.buildGrantQuery(c)
	if err != nil {
		common.BadRequest(c, err.Error())
		return
	}
	page, pageSize := adminPageParams(c)
	var total int64
	if err := q.Count(&total).Error; err != nil {
		common.InternalError(c, "读取流水失败")
		return
	}
	var grants []model.Grant
	if err := q.Order("id desc").Offset((page - 1) * pageSize).Limit(pageSize).Find(&grants).Error; err != nil {
		common.InternalError(c, "读取流水失败")
		return
	}
	usersByID, err := a.loadGrantUsers(grants)
	if err != nil {
		common.InternalError(c, "读取流水关联用户失败")
		return
	}
	items := make([]AdminGrantItem, 0, len(grants))
	for _, grant := range grants {
		item := AdminGrantItem{Grant: grant}
		if user, ok := usersByID[grant.UserID]; ok {
			item.User = &AdminGrantUser{
				ID:             user.ID,
				LinuxDOID:      user.LinuxDOID,
				LinuxDOName:    user.LinuxDOName,
				DisplayName:    user.DisplayName,
				NewapiUserID:   user.NewapiUserID,
				NewapiUsername: user.NewapiUsername,
			}
		}
		items = append(items, item)
	}
	common.Ok(c, gin.H{"total": total, "page": page, "page_size": pageSize, "items": items,
		// 前端据此判断某条失败流水是否已用尽自动重试预算(需人工介入)。
		"auto_retry_enabled":      a.Config.AutoRetryEnabled,
		"auto_retry_max_attempts": a.Config.AutoRetryMaxAttempts})
}

// loadGrantUsers 按本页流水去重后批量读取关联用户,避免逐条查询造成 N+1;
// 用户被删除时流水照常返回,调用方按「查不到」处理。
func (a *App) loadGrantUsers(grants []model.Grant) (map[int64]model.User, error) {
	usersByID := make(map[int64]model.User, len(grants))
	if len(grants) == 0 {
		return usersByID, nil
	}
	ids := make([]int64, 0, len(grants))
	seen := make(map[int64]struct{}, len(grants))
	for _, grant := range grants {
		if grant.UserID == 0 {
			continue
		}
		if _, ok := seen[grant.UserID]; ok {
			continue
		}
		seen[grant.UserID] = struct{}{}
		ids = append(ids, grant.UserID)
	}
	if len(ids) == 0 {
		return usersByID, nil
	}
	var users []model.User
	if err := a.DB.Where("id IN ?", ids).Find(&users).Error; err != nil {
		return nil, err
	}
	for _, user := range users {
		usersByID[user.ID] = user
	}
	return usersByID, nil
}

// adminGrantsExportMax 是单次导出的行数上限:导出是为了对账,不是备份数据库。
const adminGrantsExportMax = 10000

// GET /api/admin/grants/export — 按当前筛选导出 CSV。
//
// 不走 JSON 信封,直接写响应体。带 UTF-8 BOM 是为了让 Excel 双击打开时中文不乱码;
// 时间按签到配置时区展示,额度换算成美元保留 4 位,与后台页面同一口径。
func (a *App) AdminExportGrants(c *gin.Context) {
	q, err := a.buildGrantQuery(c)
	if err != nil {
		common.BadRequest(c, err.Error())
		return
	}
	var grants []model.Grant
	if err := q.Order("id desc").Limit(adminGrantsExportMax).Find(&grants).Error; err != nil {
		common.InternalError(c, "读取流水失败")
		return
	}
	usersByID, err := a.loadGrantUsers(grants)
	if err != nil {
		common.InternalError(c, "读取流水关联用户失败")
		return
	}
	loc := service.LoadLocationOr(a.checkinTimezone())
	perUnit := float64(a.Config.QuotaPerUnit)

	c.Header("Content-Type", "text/csv; charset=utf-8")
	c.Header("Content-Disposition", `attachment; filename="grants-`+time.Now().In(loc).Format("20060102")+`.csv"`)
	c.Status(http.StatusOK)
	_, _ = c.Writer.Write([]byte("\xEF\xBB\xBF"))
	w := csv.NewWriter(c.Writer)
	w.UseCRLF = true
	_ = w.Write([]string{"流水ID", "时间", "LinuxDO 用户名", "new-api 用户ID", "类型", "额度(美元)", "额度类型", "状态", "错误信息"})
	for _, g := range grants {
		name := ""
		if u, ok := usersByID[g.UserID]; ok {
			name = u.LinuxDOName
		}
		_ = w.Write([]string{
			strconv.FormatInt(g.ID, 10),
			g.CreatedAt.In(loc).Format("2006-01-02 15:04:05"),
			csvCellSafe(name),
			strconv.FormatInt(g.NewapiUserID, 10),
			g.Type,
			strconv.FormatFloat(float64(g.Quota)/perUnit, 'f', 4, 64),
			g.QuotaType,
			g.Status,
			csvCellSafe(g.Error),
		})
	}
	w.Flush()
}

// csvCellSafe 给可能被 Excel 当成公式的单元格加前导单引号。LinuxDO 用户名与 new-api
// 返回的错误信息都不由站长控制,以 = + - @ 开头的文本在 Excel 里会被当公式执行。
func csvCellSafe(s string) string {
	if s == "" {
		return s
	}
	switch s[0] {
	case '=', '+', '-', '@', '\t', '\r':
		return "'" + s
	}
	return s
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
	// 上限现在存配置表,环境变量只是首次运行的种子值(service.GetGrantConfig)。
	maxGrant := service.MaxGrantQuotaOf(a.DB, a.Config.MaxGrantQuota)
	if body.Quota == nil || *body.Quota <= 0 || *body.Quota > maxGrant {
		common.BadRequest(c, "quota 必须大于 0 且不超过上限 "+strconv.FormatInt(maxGrant, 10))
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

// GET /api/admin/users — 站内用户分页列表,支持关键词 / 绑定 / 状态筛选(R4.1, R7)。
func (a *App) AdminListUsers(c *gin.Context) {
	q := a.DB.Model(&model.User{})
	if kw := strings.TrimSpace(c.Query("keyword")); kw != "" {
		like := "%" + escapeLikeLiteral(kw) + "%"
		q = q.Where("linux_do_name LIKE ? ESCAPE '\\' OR linux_do_id LIKE ? ESCAPE '\\' OR newapi_username LIKE ? ESCAPE '\\'", like, like, like)
	}
	switch c.Query("bound") {
	case "", "all":
	case "yes":
		q = q.Where("newapi_user_id IS NOT NULL")
	case "no":
		q = q.Where("newapi_user_id IS NULL")
	default:
		common.BadRequest(c, "bound 只能为 all / yes / no")
		return
	}
	switch status := c.Query("status"); status {
	case "", "all":
	case "1", "2":
		q = q.Where("status = ?", status)
	default:
		common.BadRequest(c, "status 只能为 all / 1 / 2")
		return
	}
	page, pageSize := adminPageParams(c)
	var total int64
	if err := q.Count(&total).Error; err != nil {
		common.InternalError(c, "读取用户失败")
		return
	}
	var users []model.User
	if err := q.Order("id desc").Offset((page - 1) * pageSize).Limit(pageSize).Find(&users).Error; err != nil {
		common.InternalError(c, "读取用户失败")
		return
	}
	common.Ok(c, gin.H{"total": total, "page": page, "page_size": pageSize, "items": users})
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
	if err := service.SaveGameConfig(a.DB, &body, service.MaxGrantQuotaOf(a.DB, a.Config.MaxGrantQuota)); err != nil {
		common.BadRequest(c, err.Error())
		return
	}
	// 回的是归一化之后的 body,前端拿到的就是落库的那一份。
	common.Ok(c, body)
}

// GET/PUT /api/admin/draw-config — 读/写每日抽奖的档位表。
// 预算上限不在这里,而在 game-config 的 budgets.draw 池,两边共用同一套预算基础设施。
func (a *App) AdminGetDrawConfig(c *gin.Context) {
	cfg, err := service.GetDrawConfig(a.DB, service.MaxGrantQuotaOf(a.DB, a.Config.MaxGrantQuota))
	if err != nil {
		common.InternalError(c, "读取抽奖配置失败")
		return
	}
	common.Ok(c, cfg)
}

func (a *App) AdminPutDrawConfig(c *gin.Context) {
	var body service.DrawConfig
	if err := c.ShouldBindJSON(&body); err != nil {
		common.BadRequest(c, "JSON 格式错误")
		return
	}
	// 校验与归一化(档位按 roll_min 升序、区间必须铺满 1~100、时区回落、金额上限)
	// 全在 SaveDrawConfig 里就地完成,失败信息原样透出给站长。
	if err := service.SaveDrawConfig(a.DB, &body, service.MaxGrantQuotaOf(a.DB, a.Config.MaxGrantQuota)); err != nil {
		common.BadRequest(c, err.Error())
		return
	}
	// 回的是归一化之后的 body,前端拿到的就是落库的那一份。
	common.Ok(c, body)
}

// GET/PUT /api/admin/grant-config — 读/写单次发放上限。
//
// 这个上限同时约束手动发放、小游戏档位与抽奖档位。它此前只是 MAX_GRANT_QUOTA
// 环境变量(改一次要重启),现在存配置表,环境变量只作首次运行的种子值。
func (a *App) AdminGetGrantConfig(c *gin.Context) {
	cfg, err := service.GetGrantConfig(a.DB, a.Config.MaxGrantQuota)
	if err != nil {
		common.InternalError(c, "读取发放限制配置失败")
		return
	}
	common.Ok(c, cfg)
}

func (a *App) AdminPutGrantConfig(c *gin.Context) {
	var body service.GrantConfig
	if err := c.ShouldBindJSON(&body); err != nil {
		common.BadRequest(c, "JSON 格式错误")
		return
	}
	if err := service.SaveGrantConfig(a.DB, &body); err != nil {
		common.BadRequest(c, err.Error())
		return
	}
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
