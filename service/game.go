package service

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"strings"
	"time"

	"welfare/model"
	"welfare/service/game2048"

	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

// GrantTypeGame 是游戏发放在 w_grants.type 里的取值,ref_id 指向 w_game_plays.id。
// uk_type_ref 因此天然保证一局只有一条流水。
const GrantTypeGame = "game"

// gameSessionTTL 是一局的存活时间。超时未结算的局直接作废,不做过期恢复
// (design.md §7.2:少一个状态机分支换少一类幂等 bug)。
const gameSessionTTL = 12 * time.Hour

// gameRecentPlayLimit 是 Status 返回的最近对局条数。
const gameRecentPlayLimit = 10

// 结算原因(w_game_plays.reason),同时是前端出文案的依据。
const (
	GameReasonOK             = "ok"
	GameReasonBelowTier      = "below_tier"
	GameReasonOverDailyLimit = "over_daily_limit"
	GameReasonOverUserCap    = "over_user_cap"
	GameReasonOverSiteBudget = "over_site_budget"
	GameReasonDisabled       = "disabled"
)

// 发放状态,语义与签到接口一致:none = 本局没有产生流水。
const (
	GameGrantNone    = "none"
	GameGrantSuccess = "success"
	GameGrantFailed  = "failed"
)

var (
	ErrGameNotSupported   = errors.New("未知的游戏")
	ErrGameDisabled       = errors.New("小游戏暂未开放")
	ErrGameSessionExists  = errors.New("你已有正在进行的游戏")
	ErrGameSessionGone    = errors.New("游戏会话不存在或已结束")
	ErrGameSessionExpired = errors.New("游戏会话已过期")
	ErrGameAccountBanned  = errors.New("账号已被禁用")
	// ErrGameCheckpointMismatch:客户端带来的 base_moves 与服务端存档对不上。
	// controller 层映射为 HTTP 409,前端据此拉 /status 重新对账后重发。
	//
	// 这不是作弊信号——攻击者本来就能自由构造 moves,服务端回放照样算真分。
	// 它挡的是**重放**:客户端在 checkpoint 在途时又拿同一段 moves 发 submit,
	// 服务端会把这段算两次,分数凭空变高且无从察觉。因此按可恢复错误处理:
	// 不删会话、不写 GamePlay、不进冷却,会话与存档一个字节都不变。
	ErrGameCheckpointMismatch = errors.New("进度不同步,已为你重新对账")
)

// ensureBaseMoves 校验乐观令牌。baseMoves 是客户端认为服务端存档所处的累计有效步数,
// 必须与存档实际的 MovesApplied 相等才允许把新的一段 moves 续算上去。
func ensureBaseMoves(cp gameCheckpoint, baseMoves int) error {
	if baseMoves != cp.MovesApplied {
		return ErrGameCheckpointMismatch
	}
	return nil
}

// GameCooldownError 表示结算冷却未结束,Remaining 是剩余秒数,供前端出倒计时。
type GameCooldownError struct{ Remaining int }

func (e *GameCooldownError) Error() string {
	return fmt.Sprintf("刚结算完,请等待 %d 秒后再开一局", e.Remaining)
}

// 以下两个是只在包内流转的哨兵错误,用来把事务导向对应分支,不会返回给调用方。
var (
	// errGameSessionGone:会话已不在,转幂等分支去查首次结算结果。
	errGameSessionGone = errors.New("game: session gone")
	// errGamePlayDuplicated:uk_session 拦下了并发的重复结算,同样转幂等分支。
	errGamePlayDuplicated = errors.New("game: play duplicated")
)

// GameService 承载小游戏的会话与结算。发放一律走既有 GrantService,
// 本服务不持有任何外呼逻辑(design.md §1 分层原则)。
type GameService struct {
	db     *gorm.DB
	grants *GrantService
}

func NewGameService(db *gorm.DB, grants *GrantService) *GameService {
	return &GameService{db: db, grants: grants}
}

// IsSupportedGame 判断游戏类型是否有对应的引擎实现。配置的 games 字典里可以出现
// 别的键,但只有这里列出的游戏能开局(路由 :game 的白名单校验也用它)。
func IsSupportedGame(gameType string) bool {
	return gameType == game2048.GameType2048
}

// SupportedGames 列出所有有引擎实现的游戏,供 GET /api/games 遍历。
// 加第二个游戏时,这里和 IsSupportedGame 一起改。
func SupportedGames() []string {
	return []string{game2048.GameType2048}
}

// ---- 对外结果结构 ----

// StartResult 对应 POST /start 的响应体。
type StartResult struct {
	SessionID   string        `json:"session_id"`
	Seed        string        `json:"seed"`
	InitialGrid game2048.Grid `json:"initial_grid"`
	BaseScore   int64         `json:"base_score"`
	BaseMoves   int           `json:"base_moves"`
	ExpiresAt   time.Time     `json:"expires_at"`
}

// CheckpointResult 对应 POST /checkpoint 的响应体。
type CheckpointResult struct {
	Grid           game2048.Grid `json:"grid"`
	Score          int64         `json:"score"`
	MovesApplied   int           `json:"moves_applied"`
	MovesSubmitted int           `json:"moves_submitted"`
	ExpiresAt      time.Time     `json:"expires_at"`
}

// SettleResult 是一次结算的结果。Play 一定非空;Grant 只在真的发了额度时才有。
type SettleResult struct {
	Play        *model.GamePlay
	TierHit     *GameTier
	Grant       *model.Grant
	GrantStatus string // none | success | failed
	// OutErr 是外呼 new-api 的错误。非空表示额度还没到账,流水已是 failed,
	// 会由自动重试器补发,调用方据此给用户友好提示。
	OutErr error
	// Idempotent 为 true 表示这是重复提交,返回的是首次结算的结果,本次没有任何副作用。
	Idempotent bool
}

// ActiveSessionView 是断线恢复要用的活跃局快照。
type ActiveSessionView struct {
	SessionID string        `json:"session_id"`
	Seed      string        `json:"seed"`
	Grid      game2048.Grid `json:"grid"`
	BaseScore int64         `json:"base_score"`
	BaseMoves int           `json:"base_moves"`
	StartedAt time.Time     `json:"started_at"`
	ExpiresAt time.Time     `json:"expires_at"`
}

// GameStatusView 对应 GET /status 的响应体。
type GameStatusView struct {
	GameType          string             `json:"game_type"`
	Enabled           bool               `json:"enabled"`
	RewardType        string             `json:"reward_type"`
	Tiers             []GameTier         `json:"tiers"`
	ActiveSession     *ActiveSessionView `json:"active_session"`
	TodayClaims       int                `json:"today_claims"`
	DailyClaimLimit   int                `json:"daily_claim_limit"`
	TodayQuota        int64              `json:"today_quota"`
	UserDailyCap      int64              `json:"user_daily_cap"`
	CooldownSeconds   int                `json:"cooldown_seconds"`
	CooldownRemaining int                `json:"cooldown_remaining"`
	BudgetExhausted   bool               `json:"budget_exhausted"`
	RecentPlays       []model.GamePlay   `json:"recent_plays"`
}

// ---- 开局 ----

// Start 开一局新游戏(design.md §7.1)。
//
// 返回 seed 是安全的:种子只决定新方块出现在哪,不决定分数;分数永远由服务端
// 按同一套确定性算法重放算出,前端从不上报分数。
func (s *GameService) Start(user *model.User, gameType string) (*StartResult, error) {
	_, rules, err := s.loadRules(gameType)
	if err != nil {
		return nil, err
	}
	if !rules.Enabled {
		return nil, ErrGameDisabled
	}
	if user.NewapiUserID == nil {
		return nil, ErrNotBound
	}
	if user.Status != 1 {
		return nil, ErrGameAccountBanned
	}

	now := time.Now()
	remaining, err := s.cooldownRemaining(user.ID, gameType, rules.CooldownSeconds, now)
	if err != nil {
		return nil, err
	}
	if remaining > 0 {
		return nil, &GameCooldownError{Remaining: remaining}
	}

	// 只清已过期的旧会话。**不能连进行中的一起删**:R1.2 / AC4 要求「已有进行中的局
	// 时开新局被拒」,想换一局得先走 cancel。清过期局是为了不让 uk_user_game 在一次
	// 挂机之后把用户永久挡在门外。
	if err := s.db.Where("user_id = ? AND game_type = ? AND expires_at <= ?", user.ID, gameType, now).
		Delete(&model.GameSession{}).Error; err != nil {
		return nil, err
	}

	sessionID, err := randomHex32()
	if err != nil {
		return nil, err
	}
	// 种子必须是纯 hex(ASCII):hashToUnit 在 Go 按 rune 遍历、在 JS 按 UTF-16 码元
	// 遍历,只有全 ASCII 两端才逐位等价。引入非 ASCII 会让前后端棋盘当场分叉。
	seed, err := randomHex32()
	if err != nil {
		return nil, err
	}

	session := model.GameSession{
		ID:        sessionID,
		UserID:    user.ID,
		GameType:  gameType,
		Seed:      seed,
		StartedAt: now,
		ExpiresAt: now.Add(gameSessionTTL),
		UpdatedAt: now,
	}
	if err := s.db.Create(&session).Error; err != nil {
		// uk_user_game 是「同时只能有一局」的唯一保证,并发两个 start 只有一个能过。
		if isDuplicateErr(err) {
			return nil, ErrGameSessionExists
		}
		return nil, err
	}

	return &StartResult{
		SessionID:   session.ID,
		Seed:        session.Seed,
		InitialGrid: game2048.CreateInitialGrid(session.Seed),
		BaseScore:   0,
		BaseMoves:   0,
		ExpiresAt:   session.ExpiresAt,
	}, nil
}

// ---- 中途存档 ----

// Checkpoint 把已提交的 moves 折叠成棋盘快照存回会话并续期,前端据此清空本地
// moves 数组(design.md §7.2)。不结算、不写 GamePlay、不扣预算、不发额度。
func (s *GameService) Checkpoint(user *model.User, gameType, sessionID string, baseMoves int, moves []game2048.Direction) (*CheckpointResult, error) {
	if !IsSupportedGame(gameType) {
		return nil, ErrGameNotSupported
	}
	normalized, err := normalizeGameMoves(moves)
	if err != nil {
		return nil, err
	}

	now := time.Now()
	var out CheckpointResult
	err = s.db.Transaction(func(tx *gorm.DB) error {
		session, err := lockGameSession(tx, sessionID, gameType, user.ID, now)
		if err != nil {
			return err
		}
		cp := getCheckpoint(session)
		// 令牌校验必须在回放之前:对不上就整个事务什么都不做,存档保持原样。
		if err := ensureBaseMoves(cp, baseMoves); err != nil {
			return err
		}
		final := simulateSegment(session.Seed, cp, normalized)
		payload, err := json.Marshal(final)
		if err != nil {
			return err
		}
		expires := now.Add(gameSessionTTL)
		if err := tx.Model(&model.GameSession{}).Where("id = ?", session.ID).
			Updates(map[string]any{
				"payload":    string(payload),
				"expires_at": expires,
				"updated_at": now,
			}).Error; err != nil {
			return err
		}
		out = CheckpointResult{
			Grid:           final.Grid,
			Score:          final.Score,
			MovesApplied:   final.MovesApplied,
			MovesSubmitted: final.MovesSubmitted,
			ExpiresAt:      expires,
		}
		return nil
	})
	if errors.Is(err, errGameSessionGone) {
		return nil, ErrGameSessionGone
	}
	if err != nil {
		return nil, err
	}
	return &out, nil
}

// ---- 结算 ----

// Settle 结算一局(design.md §5 + §7.3)。顺序与既有 DoCheckin 完全一致:
// 事务内写业务记录 + pending 流水,提交后才外呼 new-api。宁可「记录成功但额度暂未到」
// (可重试补发),绝不「额度到了但本地无记录」(会双发)。
func (s *GameService) Settle(user *model.User, gameType, sessionID string, baseMoves int, moves []game2048.Direction) (*SettleResult, error) {
	cfg, rules, err := s.loadRules(gameType)
	if err != nil {
		return nil, err
	}
	normalized, err := normalizeGameMoves(moves)
	if err != nil {
		return nil, err
	}
	// 发放需要 new-api 用户 id。未绑定时直接拒绝而不写对局记录,会话保留,
	// 用户补绑之后还能把这局结算掉。
	if user.NewapiUserID == nil {
		return nil, ErrNotBound
	}

	res, err := s.settleOnce(cfg, rules, user, gameType, sessionID, baseMoves, normalized)
	if errors.Is(err, errGameSessionGone) || errors.Is(err, errGamePlayDuplicated) {
		// 会话没了或被 uk_session 拦下:这局要么已经结算过,要么根本不存在。
		return s.replaySettled(sessionID, user.ID, rules)
	}
	if err != nil {
		return nil, err
	}

	if res.Grant != nil {
		res.OutErr = s.grants.ExecuteAfterCommit(res.Grant)
		res.GrantStatus = GameGrantSuccess
		if res.OutErr != nil {
			res.GrantStatus = GameGrantFailed
		}
	}
	return res, nil
}

// settleOnce 在一个事务里跑完一次结算尝试。个人上限与两个站点预算池都按
// 实际剩余额度截断，事务内持有必要的行锁以保证并发结算不会超发。
func (s *GameService) settleOnce(cfg *GameConfig, rules GameRules, user *model.User,
	gameType, sessionID string, baseMoves int, moves []game2048.Direction,
) (*SettleResult, error) {
	now := time.Now()
	today := TodayStr(cfg.Timezone, now)

	var (
		play    model.GamePlay
		grant   *model.Grant
		tierHit *GameTier
	)
	err := s.db.Transaction(func(tx *gorm.DB) error {
		session, err := lockGameSession(tx, sessionID, gameType, user.ID, now)
		if err != nil {
			return err
		}
		cp := getCheckpoint(session)
		// 令牌校验放在回放之前:对不上就整个事务什么都不做,会话与存档保持原样,
		// 更不会写 GamePlay 或进冷却。
		if err := ensureBaseMoves(cp, baseMoves); err != nil {
			return err
		}

		final := simulateSegment(session.Seed, cp, moves)
		highest := game2048.HighestTile(final.Grid)

		reward, reason, hit, err := computeGameReward(tx, cfg, rules, user.ID, gameType, today, highest)
		if err != nil {
			return err
		}
		tierHit = hit

		play = model.GamePlay{
			UserID:      user.ID,
			GameType:    gameType,
			SessionID:   session.ID,
			PlayDate:    today,
			Score:       final.Score,
			HighestTile: highest,
			Moves:       final.MovesApplied,
			Quota:       reward,
			QuotaType:   NormalizeQuotaType(rules.RewardType),
			Reason:      reason,
		}
		if err := tx.Create(&play).Error; err != nil {
			// uk_session:同一局只能结算一次,并发的第二次在这里被拦下。
			if isDuplicateErr(err) {
				return errGamePlayDuplicated
			}
			return err
		}

		if reward > 0 {
			g := model.Grant{
				UserID:       user.ID,
				NewapiUserID: *user.NewapiUserID,
				Type:         GrantTypeGame,
				RefID:        play.ID,
				Quota:        reward,
				// 额度类型冻结在流水里:重试读流水不读配置,否则站长改了奖励类型
				// 之后补发旧流水就会发错类型(spec: newapi-integration §4)。
				QuotaType: NormalizeQuotaType(rules.RewardType),
			}
			if err := s.grants.GrantTx(tx, &g); err != nil {
				return err
			}
			grant = &g
		}

		// 删会话与写记录同事务:提交后这局再也进不来第二次结算。
		return tx.Where("id = ?", session.ID).Delete(&model.GameSession{}).Error
	})
	if err != nil {
		return nil, err
	}
	return &SettleResult{Play: &play, TierHit: tierHit, Grant: grant, GrantStatus: GameGrantNone}, nil
}

// computeGameReward 按 design.md §5 的顺序算出本局发多少、为什么。五道闸依次短路,
// 前一道判负后面的都不再查库。
func computeGameReward(tx *gorm.DB, cfg *GameConfig, rules GameRules, userID int64,
	gameType, today string, highestTile int,
) (int64, string, *GameTier, error) {
	if !rules.Enabled {
		return 0, GameReasonDisabled, nil, nil
	}

	tier, ok := MatchTier(rules.Tiers, highestTile)
	// quota<=0 的档等于没配奖励,按「没够到奖励线」处理而不是 ok:否则站长把某档
	// 配成 0,玩家达到它就会白白烧掉一次领奖机会却拿不到任何额度。
	if !ok || tier.Quota <= 0 {
		return 0, GameReasonBelowTier, nil, nil
	}

	// 同一用户的并发结算必须串行读取今日累计,否则两个事务可能同时看到
	// 相同的剩余额度或领奖次数而把个人闸击穿。锁定用户行后再读取今日数据、
	// 锁 game/total 预算行,
	// 所有结算都遵守同一锁序。
	var owner model.User
	if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).First(&owner, userID).Error; err != nil {
		return 0, "", nil, err
	}

	// 次数闸:只数 reason=ok 的笔数。没够到奖励线、被各级限额挡下的结算都不占次数(R2.3)。
	var claimed int64
	if err := tx.Model(&model.GamePlay{}).
		Where("user_id = ? AND game_type = ? AND play_date = ? AND reason = ?",
			userID, gameType, today, GameReasonOK).
		Count(&claimed).Error; err != nil {
		return 0, "", nil, err
	}
	if claimed >= int64(rules.DailyClaimLimit) {
		return 0, GameReasonOverDailyLimit, nil, nil
	}
	var todayQuota int64
	if err := tx.Model(&model.GamePlay{}).
		Where("user_id = ? AND game_type = ? AND play_date = ?", userID, gameType, today).
		Select("COALESCE(SUM(quota),0)").Scan(&todayQuota).Error; err != nil {
		return 0, "", nil, err
	}
	personalRemaining := rules.UserDailyCap - todayQuota
	if personalRemaining <= 0 {
		return 0, GameReasonOverUserCap, nil, nil
	}
	requested := tier.Quota
	if personalRemaining < requested {
		requested = personalRemaining
	}

	// 预算闸:两个池在同一事务内按固定顺序锁定,取共同剩余额度并用同一个
	// 实际金额扣减。预算不足时仍可部分发放,只有共同余额为 0 才不发。
	reward, err := ConsumeBudgetsUpTo(tx, today, requested, cfg.Budgets, []string{BudgetScopeGame, BudgetScopeTotal})
	if err != nil {
		return 0, "", nil, err
	}
	if reward <= 0 {
		return 0, GameReasonOverSiteBudget, nil, nil
	}

	hit := tier
	return reward, GameReasonOK, &hit, nil
}

// replaySettled 返回该 session 首次结算的结果(AC3)。uk_session 保证同一 session
// 至多一条 w_game_plays,因此这里不需要额外去重,也**不重新外呼**:首次结算已经
// 把流水写进 w_grants,失败的那笔归自动重试器管。
func (s *GameService) replaySettled(sessionID string, userID int64, rules GameRules) (*SettleResult, error) {
	var play model.GamePlay
	err := s.db.Where("session_id = ?", sessionID).First(&play).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, ErrGameSessionGone
	}
	if err != nil {
		return nil, err
	}
	// 别人的对局一律按「会话不存在」处理,不泄露这个 id 是否有效。
	if play.UserID != userID {
		return nil, ErrGameSessionGone
	}

	res := &SettleResult{Play: &play, GrantStatus: GameGrantNone, Idempotent: true}
	if tier, ok := MatchTier(rules.Tiers, play.HighestTile); ok && play.Quota > 0 {
		hit := tier
		res.TierHit = &hit
	}
	if play.Quota > 0 {
		var g model.Grant
		if err := s.db.Where("type = ? AND ref_id = ?", GrantTypeGame, play.ID).First(&g).Error; err == nil {
			res.Grant = &g
			// pending 与 failed 对用户是同一件事:额度还没到账,等补发。
			if g.Status == GrantStatusSuccess {
				res.GrantStatus = GameGrantSuccess
			} else {
				res.GrantStatus = GameGrantFailed
			}
		}
	}
	return res, nil
}

// ---- 放弃与状态 ----

// Cancel 放弃当前这局:删会话,不写 GamePlay、不发额度、也不设冷却。
// 冷却统一由「最近一条 GamePlay 的时间」推导(design.md §7.4),只留一个机制;
// start/cancel 刷屏由 RateLimitGame 兜底。
func (s *GameService) Cancel(user *model.User, gameType string) error {
	if !IsSupportedGame(gameType) {
		return ErrGameNotSupported
	}
	return s.db.Where("user_id = ? AND game_type = ?", user.ID, gameType).
		Delete(&model.GameSession{}).Error
}

// Status 汇总断线恢复与侧栏展示所需的一切(design.md §7.4)。
func (s *GameService) Status(user *model.User, gameType string) (*GameStatusView, error) {
	cfg, rules, err := s.loadRules(gameType)
	if err != nil {
		return nil, err
	}
	now := time.Now()
	today := TodayStr(cfg.Timezone, now)

	view := &GameStatusView{
		GameType:        gameType,
		Enabled:         rules.Enabled,
		RewardType:      NormalizeQuotaType(rules.RewardType),
		Tiers:           rules.Tiers,
		DailyClaimLimit: rules.DailyClaimLimit,
		UserDailyCap:    rules.UserDailyCap,
		CooldownSeconds: rules.CooldownSeconds,
		RecentPlays:     []model.GamePlay{},
	}

	var session model.GameSession
	err = s.db.Where("user_id = ? AND game_type = ? AND expires_at > ?", user.ID, gameType, now).
		First(&session).Error
	if err == nil {
		cp := getCheckpoint(&session)
		view.ActiveSession = &ActiveSessionView{
			SessionID: session.ID,
			Seed:      session.Seed,
			Grid:      cp.Grid,
			BaseScore: cp.Score,
			BaseMoves: cp.MovesApplied,
			StartedAt: session.StartedAt,
			ExpiresAt: session.ExpiresAt,
		}
	} else if !errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, err
	}

	var claimed int64
	if err := s.db.Model(&model.GamePlay{}).
		Where("user_id = ? AND game_type = ? AND play_date = ? AND reason = ?",
			user.ID, gameType, today, GameReasonOK).
		Count(&claimed).Error; err != nil {
		return nil, err
	}
	view.TodayClaims = int(claimed)

	if err := s.db.Model(&model.GamePlay{}).
		Where("user_id = ? AND game_type = ? AND play_date = ?", user.ID, gameType, today).
		Select("COALESCE(SUM(quota),0)").Scan(&view.TodayQuota).Error; err != nil {
		return nil, err
	}

	remaining, err := s.cooldownRemaining(user.ID, gameType, rules.CooldownSeconds, now)
	if err != nil {
		return nil, err
	}
	view.CooldownRemaining = remaining

	exhausted, err := budgetExhausted(s.db, cfg, today)
	if err != nil {
		return nil, err
	}
	view.BudgetExhausted = exhausted

	if err := s.db.Where("user_id = ? AND game_type = ?", user.ID, gameType).
		Order("id desc").Limit(gameRecentPlayLimit).Find(&view.RecentPlays).Error; err != nil {
		return nil, err
	}
	return view, nil
}

// ---- 内部工具 ----

// loadRules 读配置并取出该游戏的规则。未实现引擎的游戏一律拒绝;配置里没登记的
// 游戏读出来是零值 GameRules(Enabled=false),由调用方按「未开放」解释。
func (s *GameService) loadRules(gameType string) (*GameConfig, GameRules, error) {
	if !IsSupportedGame(gameType) {
		return nil, GameRules{}, ErrGameNotSupported
	}
	cfg, err := GetGameConfig(s.db)
	if err != nil {
		return nil, GameRules{}, err
	}
	return cfg, cfg.Games[gameType], nil
}

// cooldownRemaining 返回距离可以开新局还差几秒。冷却从最近一条对局记录起算,
// 放弃不写对局记录因此不产生冷却。
func (s *GameService) cooldownRemaining(userID int64, gameType string, cooldownSeconds int, now time.Time) (int, error) {
	if cooldownSeconds <= 0 {
		return 0, nil
	}
	var last model.GamePlay
	err := s.db.Where("user_id = ? AND game_type = ?", userID, gameType).
		Order("created_at desc, id desc").First(&last).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return 0, nil
	}
	if err != nil {
		return 0, err
	}
	left := time.Duration(cooldownSeconds)*time.Second - now.Sub(last.CreatedAt)
	if left <= 0 {
		return 0, nil
	}
	return int(math.Ceil(left.Seconds())), nil
}

// budgetExhausted 判断 game / total 两个池今日是否已经花满,供前端挂提示条。
// 只看 used >= daily,不预判下一笔奖励装不装得下 —— 真正的判定是结算事务里的
// 原子扣减,这里只是展示。
func budgetExhausted(db *gorm.DB, cfg *GameConfig, today string) (bool, error) {
	for _, scope := range []string{BudgetScopeGame, BudgetScopeTotal} {
		rule := cfg.Budgets[scope]
		if !rule.Enabled {
			continue
		}
		var row model.DailyBudget
		err := db.Where("date = ? AND scope = ?", today, scope).First(&row).Error
		if errors.Is(err, gorm.ErrRecordNotFound) {
			continue
		}
		if err != nil {
			return false, err
		}
		if row.Used >= rule.Daily {
			return true, nil
		}
	}
	return false, nil
}

// lockGameSession 取出并锁住一局进行中的游戏。归属不符一律按「会话不存在」处理,
// 不告诉调用方这个 id 属于别人。
func lockGameSession(tx *gorm.DB, sessionID, gameType string, userID int64, now time.Time) (*model.GameSession, error) {
	var session model.GameSession
	err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).
		Where("id = ? AND game_type = ?", sessionID, gameType).First(&session).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, errGameSessionGone
	}
	if err != nil {
		return nil, err
	}
	if session.UserID != userID {
		return nil, errGameSessionGone
	}
	if !now.Before(session.ExpiresAt) {
		return nil, ErrGameSessionExpired
	}
	return &session, nil
}

// normalizeGameMoves 校验方向白名单与单次提交的步数上限。
// 上限是**每次请求**的,不是整局的:checkpoint 会把已提交的步折叠成快照,
// 长局靠多次 checkpoint 推进,总步数本就没有上限。
func normalizeGameMoves(moves []game2048.Direction) ([]game2048.Direction, error) {
	// 引擎把 nil 当非法输入,但「已 checkpoint 完、本段零步」是合法场景,
	// 客户端把 moves 序列化成 null 时不该整局作废。
	if moves == nil {
		moves = []game2048.Direction{}
	}
	normalized, ok, msg := game2048.NormalizeMoves(moves, game2048.MaxMoves)
	if !ok {
		return nil, errors.New(msg)
	}
	return normalized, nil
}

// gameCheckpoint 是 w_game_sessions.payload 的结构,同时也是回放的中间状态。
type gameCheckpoint struct {
	Grid           game2048.Grid `json:"grid"`
	Score          int64         `json:"score"`
	MovesApplied   int           `json:"moves_applied"`
	MovesSubmitted int           `json:"moves_submitted"`
}

// getCheckpoint 解析存档并自校验。任何一项不合法都回退到种子初始棋盘的零状态 ——
// 这是防篡改 payload 的最后一道,故意不报错也不信任:改坏的存档只会让作弊者丢掉
// 自己已有的进度,而不是拿到一个服务端认可的高分。
func getCheckpoint(session *model.GameSession) gameCheckpoint {
	zero := gameCheckpoint{Grid: game2048.CreateInitialGrid(session.Seed)}
	if strings.TrimSpace(session.Payload) == "" {
		return zero
	}
	var cp gameCheckpoint
	if err := json.Unmarshal([]byte(session.Payload), &cp); err != nil {
		return zero
	}
	if !game2048.IsValidGrid(cp.Grid) {
		return zero
	}
	if cp.Score < 0 || cp.MovesApplied < 0 || cp.MovesSubmitted < 0 {
		return zero
	}
	if cp.MovesSubmitted < cp.MovesApplied {
		return zero
	}
	return cp
}

// simulateSegment 从存档状态续算本段 moves。
//
// 无效移动(该方向推不动)不消耗 spawn 序号:movesApplied 只在真的动了的时候自增,
// 因此伪造无效步没有任何收益。spawnIndex 从 movesApplied+2 起算,因为初始两块
// 已经占用了序号 0 和 1。这段与前端引擎必须逐位一致,改一边就得改另一边。
func simulateSegment(seed string, cp gameCheckpoint, moves []game2048.Direction) gameCheckpoint {
	grid := cp.Grid
	score := cp.Score
	applied := cp.MovesApplied
	for _, direction := range moves {
		moved := game2048.MoveGrid(grid, direction)
		if !moved.Moved {
			continue
		}
		score += moved.ScoreDelta
		grid = game2048.SpawnTile(moved.Grid, seed, applied+2)
		applied++
	}
	return gameCheckpoint{
		Grid:           grid,
		Score:          score,
		MovesApplied:   applied,
		MovesSubmitted: cp.MovesSubmitted + len(moves),
	}
}

// randomHex32 生成 32 位小写 hex(16 字节 crypto/rand)。
func randomHex32() (string, error) {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}
