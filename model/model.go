package model

import (
	"time"
)

// TableName is overridden per model to use the w_ prefix required by design.md §3.

// User is a welfare-station side user record (w_users).
type User struct {
	ID          int64  `gorm:"primaryKey;autoIncrement" json:"id"`
	LinuxDOID   string `gorm:"type:varchar(32);uniqueIndex;not null" json:"linux_do_id"`
	LinuxDOName string `gorm:"type:varchar(64);not null" json:"linux_do_name"`
	DisplayName string `gorm:"type:varchar(64)" json:"display_name"`
	// AvatarURL 为 LinuxDO 头像外链(归一化后),存量行为空串,前端需自行兜底。
	AvatarURL      string     `gorm:"type:varchar(255)" json:"avatar_url"`
	TrustLevel     int        `gorm:"not null;default:0" json:"trust_level"`
	NewapiUserID   *int64     `gorm:"uniqueIndex" json:"newapi_user_id"` // NULL = not bound
	NewapiUsername string     `gorm:"type:varchar(64)" json:"newapi_username"`
	IsAdmin        bool       `gorm:"not null;default:false" json:"is_admin"`
	Status         int        `gorm:"not null;default:1" json:"status"` // 1 normal / 2 banned (station-side)
	LastLoginAt    *time.Time `json:"last_login_at"`
	CreatedAt      time.Time  `json:"created_at"`
	UpdatedAt      time.Time  `json:"updated_at"`
}

func (User) TableName() string { return "w_users" }

// Checkin records one successful daily check-in (w_checkins).
// uk_user_date (user_id, checkin_date) is the idempotency root.
type Checkin struct {
	ID          int64     `gorm:"primaryKey;autoIncrement" json:"id"`
	UserID      int64     `gorm:"not null;uniqueIndex:uk_user_date,priority:1" json:"user_id"`
	CheckinDate string    `gorm:"type:char(10);not null;uniqueIndex:uk_user_date,priority:2" json:"checkin_date"`
	Quota       int64     `gorm:"not null" json:"quota"`  // actually granted
	Streak      int       `gorm:"not null" json:"streak"` // streak incl. today
	CreatedAt   time.Time `json:"created_at"`
}

func (Checkin) TableName() string { return "w_checkins" }

// Activity is a welfare event (w_activities).
type Activity struct {
	ID            int64     `gorm:"primaryKey;autoIncrement" json:"id"`
	Title         string    `gorm:"type:varchar(100);not null" json:"title"`
	Description   string    `gorm:"type:text" json:"description"`
	Quota         int64     `gorm:"not null" json:"quota"` // face value
	TotalCount    int       `gorm:"not null" json:"total_count"`
	ClaimedCount  int       `gorm:"not null;default:0" json:"claimed_count"` // atomically incremented
	PerUserLimit  int       `gorm:"not null;default:1" json:"per_user_limit"`
	MinTrustLevel int       `gorm:"not null;default:0" json:"min_trust_level"`
	StartAt       time.Time `gorm:"not null" json:"start_at"`
	EndAt         time.Time `gorm:"not null" json:"end_at"`
	Status        int       `gorm:"not null;default:1" json:"status"` // 1 on-shelf / 2 off-shelf
	CreatedAt     time.Time `json:"created_at"`
	UpdatedAt     time.Time `json:"updated_at"`
}

func (Activity) TableName() string { return "w_activities" }

// Claim records one activity claim by a user (w_claims).
// uk_activity_user_seq (activity_id, user_id, seq) prevents concurrent over-claims.
// idx_activity_user supports claim-count and claim-detail lookups.
type Claim struct {
	ID         int64     `gorm:"primaryKey;autoIncrement" json:"id"`
	ActivityID int64     `gorm:"not null;uniqueIndex:uk_activity_user_seq,priority:1;index:idx_activity_user,priority:1" json:"activity_id"`
	UserID     int64     `gorm:"not null;uniqueIndex:uk_activity_user_seq,priority:2;index:idx_activity_user,priority:2" json:"user_id"`
	Quota      int64     `gorm:"not null" json:"quota"`
	Seq        int       `gorm:"not null;default:1;uniqueIndex:uk_activity_user_seq,priority:3" json:"seq"` // nth claim by this user on this activity
	CreatedAt  time.Time `json:"created_at"`
}

func (Claim) TableName() string { return "w_claims" }

// Grant is the single source of truth for every payout (w_grants).
// uk_type_ref ensures one grant per business action (checkin/activity).
// Manual grants carry a unique generated ref_id so the same constraint stays safe.
type Grant struct {
	ID           int64  `gorm:"primaryKey;autoIncrement" json:"id"`
	UserID       int64  `gorm:"not null;index" json:"user_id"`
	NewapiUserID int64  `gorm:"not null" json:"newapi_user_id"`
	Type         string `gorm:"type:varchar(16);not null;uniqueIndex:uk_type_ref,priority:1" json:"type"` // checkin | activity | manual
	RefID        int64  `gorm:"not null;uniqueIndex:uk_type_ref,priority:2" json:"ref_id"`                // checkin.id / claim.id / manual snowflake-ish id
	Quota        int64  `gorm:"not null" json:"quota"`
	// QuotaType 记录本次发放的额度类型:permanent(永久余额)/ temporary(今日限时额度)。
	// 随流水持久化,重试时按这里的值重发,不读当前签到配置(否则改配置会导致补发错类型)。
	// 存量数据无此列,AutoMigrate 后为默认值 permanent。
	QuotaType string     `gorm:"type:varchar(16);not null;default:permanent" json:"quota_type"`
	Status    string     `gorm:"type:varchar(16);not null" json:"status"` // pending | success | failed
	Error     string     `gorm:"type:varchar(500)" json:"error"`
	RetriedAt *time.Time `json:"retried_at"`
	CreatedAt time.Time  `json:"created_at"`
	UpdatedAt time.Time  `json:"updated_at"`
}

func (Grant) TableName() string { return "w_grants" }

// Setting stores single-row JSON config values (w_settings).
type Setting struct {
	Key       string    `gorm:"type:varchar(64);primaryKey" json:"key"`
	Value     string    `gorm:"type:text;not null" json:"value"` // JSON text
	UpdatedAt time.Time `json:"updated_at"`
}

func (Setting) TableName() string { return "w_settings" }

// AllModels lists every AutoMigrate target in dependency order.
func AllModels() []any {
	return []any{
		&User{},
		&Checkin{},
		&Activity{},
		&Claim{},
		&Grant{},
		&Setting{},
	}
}
