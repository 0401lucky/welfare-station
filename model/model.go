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
	// RetryCount / NextRetryAt 供后台自动重试器使用:失败一次计数 +1 并按退避表推迟
	// 下次可重试时间。存量行 AutoMigrate 后为 0 / NULL,即「立即可重试、预算全满」。
	RetryCount  int        `gorm:"not null;default:0" json:"retry_count"`
	NextRetryAt *time.Time `json:"next_retry_at"` // NULL = 立即可重试
	CreatedAt   time.Time  `json:"created_at"`
	UpdatedAt   time.Time  `json:"updated_at"`
}

func (Grant) TableName() string { return "w_grants" }

// Setting stores single-row JSON config values (w_settings).
type Setting struct {
	Key       string    `gorm:"type:varchar(64);primaryKey" json:"key"`
	Value     string    `gorm:"type:text;not null" json:"value"` // JSON text
	UpdatedAt time.Time `json:"updated_at"`
}

func (Setting) TableName() string { return "w_settings" }

// GameSession 是一局进行中的游戏(w_game_sessions)。
// uk_user_game 保证一个用户同一游戏同时只有一局;开新局前先删旧局。
type GameSession struct {
	ID       string `gorm:"type:char(32);primaryKey" json:"id"`
	UserID   int64  `gorm:"not null;uniqueIndex:uk_user_game,priority:1" json:"user_id"`
	GameType string `gorm:"type:varchar(16);not null;uniqueIndex:uk_user_game,priority:2" json:"game_type"`
	Seed     string `gorm:"type:char(32);not null" json:"seed"`
	// Payload 存 checkpoint 快照 JSON:{grid, score, moves_applied, moves_submitted}。
	// 空串表示尚无 checkpoint,回放从种子初始棋盘开始。
	Payload   string    `gorm:"type:text" json:"payload"`
	StartedAt time.Time `gorm:"not null" json:"started_at"`
	ExpiresAt time.Time `gorm:"not null;index" json:"expires_at"`
	UpdatedAt time.Time `json:"updated_at"`
}

func (GameSession) TableName() string { return "w_game_sessions" }

// GamePlay 是一局已结算的对局记录(w_game_plays),同时是 w_grants 的 ref。
// uk_session 是结算幂等的根基:同一 session 只能结算一次。
type GamePlay struct {
	ID          int64  `gorm:"primaryKey;autoIncrement" json:"id"`
	UserID      int64  `gorm:"not null;index:idx_user_date,priority:1" json:"user_id"`
	GameType    string `gorm:"type:varchar(16);not null" json:"game_type"`
	SessionID   string `gorm:"type:char(32);not null;uniqueIndex:uk_session" json:"session_id"`
	PlayDate    string `gorm:"type:char(10);not null;index:idx_user_date,priority:2" json:"play_date"` // 配置时区的 YYYY-MM-DD
	Score       int64  `gorm:"not null" json:"score"`
	HighestTile int    `gorm:"not null" json:"highest_tile"`
	Moves       int    `gorm:"not null" json:"moves"`
	Quota       int64  `gorm:"not null;default:0" json:"quota"` // 实发额度,0 = 未发放
	QuotaType   string `gorm:"type:varchar(16);not null;default:permanent" json:"quota_type"`
	// Reason 记录本次为何发/未发,供前端出文案与后台排查:
	// ok | below_tier | over_daily_limit | over_user_cap | over_site_budget | disabled
	Reason    string    `gorm:"type:varchar(32);not null" json:"reason"`
	CreatedAt time.Time `json:"created_at"`
}

func (GamePlay) TableName() string { return "w_game_plays" }

// DailyBudget 记录某日某个池已发放的额度(w_daily_budgets)。
// 预算上限存配置不存表,这里只记 used,改配置立即生效。
// Scope: total | game | checkin | activity
type DailyBudget struct {
	Date      string    `gorm:"type:char(10);primaryKey" json:"date"`
	Scope     string    `gorm:"type:varchar(16);primaryKey" json:"scope"`
	Used      int64     `gorm:"not null;default:0" json:"used"`
	UpdatedAt time.Time `json:"updated_at"`
}

func (DailyBudget) TableName() string { return "w_daily_budgets" }

// AllModels lists every AutoMigrate target in dependency order.
func AllModels() []any {
	return []any{
		&User{},
		&Checkin{},
		&Activity{},
		&Claim{},
		&Grant{},
		&Setting{},
		&GameSession{},
		&GamePlay{},
		&DailyBudget{},
	}
}
