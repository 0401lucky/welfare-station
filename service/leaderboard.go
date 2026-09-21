package service

import (
	"database/sql"
	"strconv"
	"sync"
	"time"

	"welfare/model"

	"gorm.io/gorm"
)

// 排行榜种类。
const (
	LeaderboardKindStreak = "streak" // 当前连签天数
	LeaderboardKindGame   = "game"   // 本周(配置时区周一起)小游戏最高分
)

const (
	leaderboardLimit = 20
	leaderboardTTL   = 60 * time.Second
)

// LeaderboardEntry 只暴露展示所需的字段,不带 LinuxDO ID 等身份信息。
type LeaderboardEntry struct {
	UserID    int64  `json:"user_id"`
	Name      string `json:"name"`
	AvatarURL string `json:"avatar_url"`
	Value     int64  `json:"value"`
	// GameType 只在高分榜出现:该用户本周最高分来自哪款游戏。
	GameType string `json:"game_type,omitempty"`
}

// LeaderboardRank 是登录用户自己的名次;不在榜上(连签为 0 / 本周没玩)时整个字段省略。
type LeaderboardRank struct {
	Rank  int   `json:"rank"`
	Value int64 `json:"value"`
}

type LeaderboardView struct {
	Kind string `json:"kind"`
	// Since 是统计起点:连签榜为今天,高分榜为本周一,均按签到配置时区。
	Since string             `json:"since"`
	Items []LeaderboardEntry `json:"items"`
	Me    *LeaderboardRank   `json:"me,omitempty"`
}

// IsLeaderboardKind 判断种类是否合法。
func IsLeaderboardKind(kind string) bool {
	return kind == LeaderboardKindStreak || kind == LeaderboardKindGame
}

// WeekStart 返回 now 所在周的周一(配置时区)的 YYYY-MM-DD。
func WeekStart(timezone string, now time.Time) string {
	local := now.In(LoadLocationOr(timezone))
	weekday := int(local.Weekday())
	if weekday == 0 {
		weekday = 7
	}
	return local.AddDate(0, 0, -(weekday - 1)).Format("2006-01-02")
}

// 榜单本体按 kind + 统计起点缓存 60 秒;「我的名次」每次现算,不进缓存。
type leaderboardCached struct {
	items []LeaderboardEntry
	at    time.Time
}

var leaderboardCache = struct {
	mu sync.Mutex
	m  map[string]leaderboardCached
}{m: map[string]leaderboardCached{}}

// ResetLeaderboardCache 清空进程内缓存,测试用。
func ResetLeaderboardCache() {
	leaderboardCache.mu.Lock()
	defer leaderboardCache.mu.Unlock()
	leaderboardCache.m = map[string]leaderboardCached{}
}

func cachedLeaderboard(key string, now time.Time) ([]LeaderboardEntry, bool) {
	leaderboardCache.mu.Lock()
	defer leaderboardCache.mu.Unlock()
	c, ok := leaderboardCache.m[key]
	if !ok || now.Sub(c.at) >= leaderboardTTL {
		return nil, false
	}
	out := make([]LeaderboardEntry, len(c.items))
	copy(out, c.items)
	return out, true
}

func storeLeaderboard(key string, items []LeaderboardEntry, now time.Time) {
	leaderboardCache.mu.Lock()
	defer leaderboardCache.mu.Unlock()
	kept := make([]LeaderboardEntry, len(items))
	copy(kept, items)
	leaderboardCache.m[key] = leaderboardCached{items: kept, at: now}
}

// leaderboardRow 是榜单查询的扫描目标;列名与 Select 里的别名一一对应。
type leaderboardRow struct {
	UserID      int64
	Value       int64
	DisplayName string
	LinuxDOName string
	AvatarURL   string
}

func (r leaderboardRow) entry() LeaderboardEntry {
	name := r.DisplayName
	if name == "" {
		name = r.LinuxDOName
	}
	if name == "" {
		name = "用户 #" + strconv.FormatInt(r.UserID, 10)
	}
	return LeaderboardEntry{UserID: r.UserID, Name: name, AvatarURL: r.AvatarURL, Value: r.Value}
}

// activeStreakQuery 选出「连签未断」的用户:最近一次签到落在今天或昨天,
// 且站内账号正常。子查询取每人最近一次签到,再回表拿到 streak。
func activeStreakQuery(db *gorm.DB, dates []string) *gorm.DB {
	latest := db.Table(model.Checkin{}.TableName()).Select("user_id, MAX(checkin_date) AS latest").Group("user_id")
	return db.Table(model.Checkin{}.TableName()+" AS c").
		Joins("JOIN (?) AS l ON l.user_id = c.user_id AND l.latest = c.checkin_date", latest).
		Joins("JOIN "+model.User{}.TableName()+" AS u ON u.id = c.user_id AND u.status = 1").
		Where("c.checkin_date IN ?", dates)
}

// StreakTop 返回当前连签天数前 limit 名。
func StreakTop(db *gorm.DB, timezone string, now time.Time, limit int) ([]LeaderboardEntry, error) {
	dates := []string{TodayStr(timezone, now), TodayStr(timezone, now.AddDate(0, 0, -1))}
	var rows []leaderboardRow
	err := activeStreakQuery(db, dates).
		Select("c.user_id AS user_id, c.streak AS value, u.display_name, u.linux_do_name, u.avatar_url").
		Order("c.streak DESC, c.user_id ASC").
		Limit(limit).
		Scan(&rows).Error
	if err != nil {
		return nil, err
	}
	items := make([]LeaderboardEntry, 0, len(rows))
	for _, r := range rows {
		items = append(items, r.entry())
	}
	return items, nil
}

// streakRank 返回用户在连签榜的名次;连签为 0 时不在榜上,返回 nil。
func streakRank(db *gorm.DB, timezone string, now time.Time, userID int64) (*LeaderboardRank, error) {
	streak, err := CurrentStreak(db, userID, timezone, now)
	if err != nil || streak == 0 {
		return nil, err
	}
	dates := []string{TodayStr(timezone, now), TodayStr(timezone, now.AddDate(0, 0, -1))}
	var ahead int64
	if err := activeStreakQuery(db, dates).Where("c.streak > ?", streak).Count(&ahead).Error; err != nil {
		return nil, err
	}
	return &LeaderboardRank{Rank: int(ahead) + 1, Value: int64(streak)}, nil
}

// weeklyBestQuery 是本周每人最高分的子查询(只算账号正常的用户)。
func weeklyBestQuery(db *gorm.DB, weekStart string) *gorm.DB {
	return db.Table(model.GamePlay{}.TableName()+" AS p").
		Select("p.user_id AS user_id, MAX(p.score) AS best").
		Joins("JOIN "+model.User{}.TableName()+" AS u ON u.id = p.user_id AND u.status = 1").
		Where("p.play_date >= ?", weekStart).
		Group("p.user_id")
}

// GameTop 返回本周最高分前 limit 名,并标注最高分来自哪款游戏。
func GameTop(db *gorm.DB, weekStart string, limit int) ([]LeaderboardEntry, error) {
	var rows []leaderboardRow
	err := db.Table("(?) AS b", weeklyBestQuery(db, weekStart)).
		Select("b.user_id AS user_id, b.best AS value, u.display_name, u.linux_do_name, u.avatar_url").
		Joins("JOIN " + model.User{}.TableName() + " AS u ON u.id = b.user_id").
		Order("b.best DESC, b.user_id ASC").
		Limit(limit).
		Scan(&rows).Error
	if err != nil {
		return nil, err
	}
	if len(rows) == 0 {
		return []LeaderboardEntry{}, nil
	}
	ids := make([]int64, 0, len(rows))
	for _, r := range rows {
		ids = append(ids, r.UserID)
	}
	// 每人每款游戏的最高分至多一行,拿来判断最高分出自哪款;并列时按游戏名排序取第一个。
	var kinds []struct {
		UserID   int64
		GameType string
		Best     int64
	}
	err = db.Table(model.GamePlay{}.TableName()).
		Select("user_id, game_type, MAX(score) AS best").
		Where("user_id IN ? AND play_date >= ?", ids, weekStart).
		Group("user_id, game_type").
		Order("user_id, game_type").
		Scan(&kinds).Error
	if err != nil {
		return nil, err
	}
	gameOf := make(map[int64]string, len(rows))
	for _, k := range kinds {
		if _, done := gameOf[k.UserID]; done {
			continue
		}
		for _, r := range rows {
			if r.UserID == k.UserID && r.Value == k.Best {
				gameOf[k.UserID] = k.GameType
				break
			}
		}
	}
	items := make([]LeaderboardEntry, 0, len(rows))
	for _, r := range rows {
		e := r.entry()
		e.GameType = gameOf[r.UserID]
		items = append(items, e)
	}
	return items, nil
}

// gameRank 返回用户在本周高分榜的名次;本周没玩过返回 nil。
func gameRank(db *gorm.DB, weekStart string, userID int64) (*LeaderboardRank, error) {
	var mine struct{ Best sql.NullInt64 }
	err := db.Table(model.GamePlay{}.TableName()).
		Select("MAX(score) AS best").
		Where("user_id = ? AND play_date >= ?", userID, weekStart).
		Scan(&mine).Error
	if err != nil || !mine.Best.Valid {
		return nil, err
	}
	var ahead int64
	if err := db.Table("(?) AS b", weeklyBestQuery(db, weekStart)).Where("b.best > ?", mine.Best.Int64).Count(&ahead).Error; err != nil {
		return nil, err
	}
	return &LeaderboardRank{Rank: int(ahead) + 1, Value: mine.Best.Int64}, nil
}

// Leaderboard 组装榜单:本体走 60 秒缓存,「我的名次」按 viewer 现算(viewer 可为 nil)。
func Leaderboard(db *gorm.DB, kind, timezone string, now time.Time, viewer *model.User) (*LeaderboardView, error) {
	var since string
	if kind == LeaderboardKindGame {
		since = WeekStart(timezone, now)
	} else {
		since = TodayStr(timezone, now)
	}
	key := kind + ":" + since
	items, hit := cachedLeaderboard(key, now)
	if !hit {
		var err error
		if kind == LeaderboardKindGame {
			items, err = GameTop(db, since, leaderboardLimit)
		} else {
			items, err = StreakTop(db, timezone, now, leaderboardLimit)
		}
		if err != nil {
			return nil, err
		}
		storeLeaderboard(key, items, now)
	}
	view := &LeaderboardView{Kind: kind, Since: since, Items: items}
	if viewer != nil {
		var err error
		if kind == LeaderboardKindGame {
			view.Me, err = gameRank(db, since, viewer.ID)
		} else {
			view.Me, err = streakRank(db, timezone, now, viewer.ID)
		}
		if err != nil {
			return nil, err
		}
	}
	return view, nil
}
