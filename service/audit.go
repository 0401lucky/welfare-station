package service

import (
	"encoding/json"
	"log"
	"time"

	"welfare/model"

	"gorm.io/gorm"
)

// 审计动作常量。前端下拉与文案按这份清单对齐,新增写接口时先在这里登记。
const (
	AuditManualGrant      = "manual_grant"
	AuditRetryGrant       = "retry_grant"
	AuditBanUser          = "ban_user"
	AuditUnbanUser        = "unban_user"
	AuditCreateActivity   = "create_activity"
	AuditUpdateActivity   = "update_activity"
	AuditDeleteActivity   = "delete_activity"
	AuditPutCheckinConfig = "put_checkin_config"
	AuditPutGameConfig    = "put_game_config"
	AuditPutDrawConfig    = "put_draw_config"
	AuditPutGrantConfig   = "put_grant_config"
	AuditPutSiteNotice    = "put_site_notice"
	AuditPutUserNote      = "put_user_note"
)

// AuditActions 是全部合法动作,日志筛选只认这份清单里的值。
var AuditActions = []string{
	AuditManualGrant, AuditRetryGrant, AuditBanUser, AuditUnbanUser,
	AuditCreateActivity, AuditUpdateActivity, AuditDeleteActivity,
	AuditPutCheckinConfig, AuditPutGameConfig, AuditPutDrawConfig, AuditPutGrantConfig,
	AuditPutSiteNotice, AuditPutUserNote,
}

// IsAuditAction 判断动作名是否在清单内。
func IsAuditAction(action string) bool {
	for _, a := range AuditActions {
		if a == action {
			return true
		}
	}
	return false
}

// 审计对象类型(w_admin_logs.target_type)。
const (
	AuditTargetGrant    = "grant"
	AuditTargetUser     = "user"
	AuditTargetActivity = "activity"
	AuditTargetSetting  = "setting"
)

// auditDetailMaxRunes 是 detail 的长度上限,按字符数截断,避免把多字节字符切成半个。
const auditDetailMaxRunes = 2000

// RecordAudit 记录一条管理员操作。
//
// 审计写入不进业务事务:发放已经成功了,审计表写不进去不该让站长看到「发放失败」;
// 接受极小概率漏记,失败只打日志。actor 为空(理论上不会)时 admin_user_id 记 0。
// detail 任意可 JSON 序列化的值,序列化失败时把错误原样存进去以便排查。
func RecordAudit(db *gorm.DB, actor *model.User, action, targetType string, targetID int64, detail any, ip string) {
	var adminID int64
	if actor != nil {
		adminID = actor.ID
	}
	row := model.AdminLog{
		AdminUserID: adminID,
		Action:      action,
		TargetType:  targetType,
		TargetID:    targetID,
		Detail:      marshalAuditDetail(detail),
		IP:          ip,
		CreatedAt:   time.Now(),
	}
	if err := db.Create(&row).Error; err != nil {
		log.Printf("audit: 写入失败 action=%s admin=%d target=%s#%d: %v", action, adminID, targetType, targetID, err)
	}
}

// marshalAuditDetail 把 detail 序列化并按字符数截断;nil 存空串。
func marshalAuditDetail(detail any) string {
	if detail == nil {
		return ""
	}
	b, err := json.Marshal(detail)
	if err != nil {
		return `{"marshal_error":` + strconvQuote(err.Error()) + `}`
	}
	s := string(b)
	if runes := []rune(s); len(runes) > auditDetailMaxRunes {
		return string(runes[:auditDetailMaxRunes])
	}
	return s
}

// strconvQuote 是 json 字符串转义的极简版,只用于错误信息这一处,避免再引一次 encoding/json。
func strconvQuote(s string) string {
	b, err := json.Marshal(s)
	if err != nil {
		return `""`
	}
	return string(b)
}

// AuditDiff 是配置类动作的 detail 形状:变更前后各一份快照。
type AuditDiff struct {
	Before any `json:"before"`
	After  any `json:"after"`
}
