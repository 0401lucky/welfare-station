package controller

import (
	"errors"
	"net/http"

	"welfare/common"
	"welfare/middleware"
	"welfare/model"
	"welfare/service"
	"welfare/service/game2048"

	"github.com/gin-gonic/gin"
)

// gameMovesReq 是 checkpoint 与 submit 的请求体。
//
// 注意这里**没有也不会有** score / quota / grid 之类的字段:分数一律由服务端
// 从种子回放算出,前端只提交操作序列。任何"直接指定得分"的入口都不存在。
type gameMovesReq struct {
	SessionID string               `json:"session_id"`
	BaseMoves int                  `json:"base_moves"`
	Moves     []game2048.Direction `json:"moves"`
}

// gameSvc 组装本次请求要用的 GameService。发放一律走既有 GrantService。
func (a *App) gameSvc() *service.GameService {
	return service.NewGameService(a.DB, service.NewGrantService(a.DB, a.NewAPI))
}

// requireGameUser 取当前用户并校验 :game 参数在白名单内。
// 返回的 ok=false 表示已经写过响应,调用方直接 return。
func (a *App) requireGameUser(c *gin.Context) (*model.User, string, bool) {
	user := middleware.CurrentUser(c)
	if user == nil {
		common.Unauthorized(c, "未登录")
		return nil, "", false
	}
	gameType := c.Param("game")
	if !service.IsSupportedGame(gameType) {
		common.Fail(c, http.StatusNotFound, service.ErrGameNotSupported.Error())
		return nil, "", false
	}
	return user, gameType, true
}

// failGame 把 service 层的错误映射成 HTTP 状态码。
//
// ErrGameCheckpointMismatch 单独映射为 409:前端据此拉 /status 重新对账后重发。
// 它不是作弊信号,服务端此时没有任何副作用(会话与存档原封不动)。
func failGame(c *gin.Context, err error) {
	var cooldown *service.GameCooldownError
	switch {
	case errors.As(err, &cooldown):
		common.FailData(c, http.StatusBadRequest, cooldown.Error(),
			gin.H{"cooldown_remaining": cooldown.Remaining})
	case errors.Is(err, service.ErrGameCheckpointMismatch):
		common.Fail(c, http.StatusConflict, err.Error())
	case errors.Is(err, service.ErrGameNotSupported):
		common.Fail(c, http.StatusNotFound, err.Error())
	case errors.Is(err, service.ErrGameDisabled),
		errors.Is(err, service.ErrGameSessionExists),
		errors.Is(err, service.ErrGameSessionGone),
		errors.Is(err, service.ErrGameSessionExpired),
		errors.Is(err, service.ErrNotBound):
		common.Fail(c, http.StatusBadRequest, err.Error())
	case errors.Is(err, service.ErrGameAccountBanned):
		common.Fail(c, http.StatusForbidden, err.Error())
	default:
		common.InternalError(c, err.Error())
	}
}

// GET /api/games — 游戏列表与各自的规则摘要 / 今日进度。
func (a *App) ListGames(c *gin.Context) {
	user := middleware.CurrentUser(c)
	if user == nil {
		common.Unauthorized(c, "未登录")
		return
	}
	svc := a.gameSvc()
	out := make([]gin.H, 0, 1)
	for _, gameType := range service.SupportedGames() {
		st, err := svc.Status(user, gameType)
		if err != nil {
			common.InternalError(c, err.Error())
			return
		}
		out = append(out, gin.H{
			"game_type": st.GameType,
			"enabled":   st.Enabled,
			// rules_summary 必须是完整的 GameRules:前端的「下一档奖励门槛」
			// 文案只能从 tiers 算,裁剪掉就没法出这句话了。
			"rules_summary": gin.H{
				"enabled":           st.Enabled,
				"reward_type":       st.RewardType,
				"daily_claim_limit": st.DailyClaimLimit,
				"user_daily_cap":    st.UserDailyCap,
				"cooldown_seconds":  st.CooldownSeconds,
				"tiers":             st.Tiers,
			},
			"today_claims":      st.TodayClaims,
			"daily_claim_limit": st.DailyClaimLimit,
			"today_quota":       st.TodayQuota,
			"user_daily_cap":    st.UserDailyCap,
			"budget_exhausted":  st.BudgetExhausted,
		})
	}
	common.Ok(c, out)
}

// GET /api/games/:game/status — 活跃局(断线恢复)+ 今日进度 + 最近对局。
func (a *App) GameStatus(c *gin.Context) {
	user, gameType, ok := a.requireGameUser(c)
	if !ok {
		return
	}
	st, err := a.gameSvc().Status(user, gameType)
	if err != nil {
		failGame(c, err)
		return
	}
	common.Ok(c, st)
}

// POST /api/games/:game/start — 开局。返回的 seed 只决定新方块出现在哪,
// 不决定分数;分数永远由服务端回放算出。
func (a *App) GameStart(c *gin.Context) {
	user, gameType, ok := a.requireGameUser(c)
	if !ok {
		return
	}
	res, err := a.gameSvc().Start(user, gameType)
	if err != nil {
		failGame(c, err)
		return
	}
	common.Ok(c, res)
}

// POST /api/games/:game/checkpoint — 中途存档。不结算、不发额度。
func (a *App) GameCheckpoint(c *gin.Context) {
	user, gameType, ok := a.requireGameUser(c)
	if !ok {
		return
	}
	var req gameMovesReq
	if err := c.ShouldBindJSON(&req); err != nil {
		common.Fail(c, http.StatusBadRequest, "参数错误")
		return
	}
	res, err := a.gameSvc().Checkpoint(user, gameType, req.SessionID, req.BaseMoves, req.Moves)
	if err != nil {
		failGame(c, err)
		return
	}
	common.Ok(c, res)
}

// POST /api/games/:game/submit — 结算。服务端回放 moves 算真实分数后决定奖励。
func (a *App) GameSubmit(c *gin.Context) {
	user, gameType, ok := a.requireGameUser(c)
	if !ok {
		return
	}
	var req gameMovesReq
	if err := c.ShouldBindJSON(&req); err != nil {
		common.Fail(c, http.StatusBadRequest, "参数错误")
		return
	}
	res, err := a.gameSvc().Settle(user, gameType, req.SessionID, req.BaseMoves, req.Moves)
	if err != nil {
		failGame(c, err)
		return
	}

	data := gin.H{
		"score":        res.Play.Score,
		"highest_tile": res.Play.HighestTile,
		"moves":        res.Play.Moves,
		"quota":        res.Play.Quota,
		"quota_type":   res.Play.QuotaType,
		"reason":       res.Play.Reason,
		"grant_status": res.GrantStatus,
		"tier_hit":     res.TierHit,
	}
	if res.OutErr != nil {
		// 对局已记录,额度由自动重试器补发。语义与签到接口一致。
		common.FailData(c, http.StatusOK, "成绩已记录,但额度发放遇到问题,稍后会自动补发", data)
		return
	}
	common.Ok(c, data)
}

// POST /api/games/:game/cancel — 放弃当前局。不结算、不发额度、不消耗领奖次数、
// 也不设冷却(冷却统一由最近一条对局记录推导)。
func (a *App) GameCancel(c *gin.Context) {
	user, gameType, ok := a.requireGameUser(c)
	if !ok {
		return
	}
	if err := a.gameSvc().Cancel(user, gameType); err != nil {
		failGame(c, err)
		return
	}
	common.Ok(c, gin.H{})
}
