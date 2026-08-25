package service

import (
	"errors"
	"math/rand/v2"
	"time"

	"welfare/model"

	"gorm.io/gorm"
)

// GrantTypeDraw 是抽奖发放在 w_grants.type 里的取值,ref_id 指向 w_draws.id。
// uk_type_ref 因此天然保证一次抽奖只有一条流水。
const GrantTypeDraw = "draw"

// 抽奖结算原因(w_draws.reason),同时是前端出文案的依据。
const (
	DrawReasonOK             = "ok"               // 中奖并成功排入发放
	DrawReasonNoPrize        = "no_prize"         // 命中无额度档,纯趣味数字
	DrawReasonJackpotFalback = "jackpot_fallback" // 永久大奖名额已满,降级为限时额度发放
	DrawReasonOverBudget     = "over_site_budget" // 中了但当日预算池已空,不发额度
)

var (
	// ErrDrawDisabled 抽奖功能被站长关闭。
	ErrDrawDisabled = errors.New("今日抽奖暂未开放")
	// ErrAlreadyDrawn 今日已抽过(uk_user_draw_date 兜底,也在入口先查一次给友好文案)。
	ErrAlreadyDrawn = errors.New("今天已经摇过四叶草啦,明天再来")
	// ErrDrawNotBound 未绑定 new-api,中奖也没处发。
	ErrDrawNotBound = errors.New("请先绑定 new-api 账号再来抽奖")
)

// DrawService 承载每日幸运抽奖。发放一律走既有 GrantService,本服务不持有外呼逻辑
// (与 GameService 同一分层原则)。
type DrawService struct {
	db     *gorm.DB
	grants *GrantService
}

func NewDrawService(db *gorm.DB, grants *GrantService) *DrawService {
	return &DrawService{db: db, grants: grants}
}

// DrawResult 是一次抽奖的结算结果。
type DrawResult struct {
	Draw  *model.Draw
	Grant *model.Grant // nil 表示本次没有产生发放(无额度档或预算已空)
	Tier  DrawTier     // 命中的档位(快照前的原始档,供前端出文案)
	// OutErr 是 new-api 外呼错误;nil 表示额度已到账。语义与签到一致:
	// 非 nil 时记录已写下,额度由自动重试器补发。
	OutErr error
}

// rollLucky 摇一个 1-100 的幸运数字。用 math/rand/v2,与签到 ComputeReward 同源。
// 抽出的数字既是展示用的「今日幸运指数」,也是奖励档位的唯一依据。
func rollLucky() int {
	return 1 + rand.IntN(100)
}

// pickQuota 在档位的 [min,max] 区间随机一个整数额度。相等即固定,0 即无额度。
func pickQuota(t DrawTier) int64 {
	if t.MaxQuota <= 0 {
		return 0
	}
	lo, hi := t.MinQuota, t.MaxQuota
	if hi <= lo {
		return lo
	}
	return lo + rand.Int64N(hi-lo+1)
}

// DoDraw 执行一次每日抽奖(每人每天一次,幂等根 = uk_user_draw_date)。
//
// 流程与 DoCheckin 同构:
//  1. 校验开关 / 绑定 / 当日是否已抽
//  2. 服务端摇幸运数字,命中档位,算金额
//  3. 一个事务内:插 w_draws(唯一约束幂等) + 按档扣预算 + 按档写 pending w_grants
//  4. 提交后同步外呼发放,失败转自动重试
//
// 预算扣减放在**同一事务内**:若 w_draws 撞唯一键(并发的第二次抽奖)整个事务回滚,
// 已扣的预算随之撤销,不会出现「抽奖记录没写成、预算却被吃掉」的账。
func (s *DrawService) DoDraw(cfg *DrawConfig, gameCfg *GameConfig, user *model.User) (*DrawResult, error) {
	if !cfg.Enabled {
		return nil, ErrDrawDisabled
	}
	if user.NewapiUserID == nil {
		return nil, ErrDrawNotBound
	}

	now := time.Now()
	today := TodayStr(cfg.Timezone, now)

	// 入口先查一次:给「今天已抽过」一个友好错误,而不是等唯一键抛库层错误。
	// 真正防并发重复的是事务里的 uk_user_draw_date,这里只是体验优化。
	var existing int64
	if err := s.db.Model(&model.Draw{}).
		Where("user_id = ? AND draw_date = ?", user.ID, today).
		Count(&existing).Error; err != nil {
		return nil, err
	}
	if existing > 0 {
		return nil, ErrAlreadyDrawn
	}

	roll := rollLucky()
	tier, ok := MatchDrawTier(cfg.Tiers, roll)
	if !ok {
		// 配置有洞(理论上被 SaveDrawConfig 挡住),兜底成无奖,别让用户白抽一次还报错。
		tier = DrawTier{Label: "一般般绿", Quip: "今天的运气很朴素,四叶草在替你攒着。", RewardType: QuotaTypeTemporary}
	}
	wantQuota := pickQuota(tier)

	var (
		draw  model.Draw
		grant *model.Grant
	)
	err := s.db.Transaction(func(tx *gorm.DB) error {
		reward, quotaType, reason, err := s.resolveReward(tx, gameCfg, tier, wantQuota, today)
		if err != nil {
			return err
		}

		draw = model.Draw{
			UserID:    user.ID,
			DrawDate:  today,
			Roll:      roll,
			TierLabel: tier.Label,
			Quota:     reward,
			QuotaType: quotaType,
			Reason:    reason,
		}
		if err := tx.Create(&draw).Error; err != nil {
			if isDuplicateErr(err) {
				return ErrAlreadyDrawn
			}
			return err
		}

		if reward > 0 {
			g := model.Grant{
				UserID:       user.ID,
				NewapiUserID: *user.NewapiUserID,
				Type:         GrantTypeDraw,
				RefID:        draw.ID,
				Quota:        reward,
				// 额度类型冻结在流水里:重试读流水不读配置,与签到/游戏一致。
				QuotaType: quotaType,
			}
			if err := s.grants.GrantTx(tx, &g); err != nil {
				return err
			}
			grant = &g
		}
		return nil
	})
	if err != nil {
		return nil, err
	}

	res := &DrawResult{Draw: &draw, Grant: grant, Tier: tier}
	if grant != nil {
		res.OutErr = s.grants.ExecuteAfterCommit(grant)
	}
	return res, nil
}

// resolveReward 在结算事务内决定本次实发多少、什么类型、原因。
//
// 三道处理依次:
//  1. 无额度档(wantQuota<=0):直接 no_prize,不碰预算、不发放。
//  2. 永久大奖名额:命中永久档且配了 DailyWinnerLimit 时,数一下今日该档已中几人,
//     满了就把额度类型降级为限时(reason=jackpot_fallback),金额不变。
//     这是软限制(不加全局锁),真正防超发的硬闸是下面的预算池。
//  3. 预算闸:draw / total 两池按固定锁序原子扣减,取共同剩余额度截断。
//     共同余额为 0 则不发(over_site_budget),否则按实扣额度发放。
func (s *DrawService) resolveReward(tx *gorm.DB, gameCfg *GameConfig, tier DrawTier, wantQuota int64, today string,
) (reward int64, quotaType, reason string, err error) {
	quotaType = NormalizeQuotaType(tier.RewardType)

	if wantQuota <= 0 {
		return 0, quotaType, DrawReasonNoPrize, nil
	}

	fallbackReason := DrawReasonOK
	// 永久大奖的每日名额:满了降级为限时额度兜底,让「永久」这个稀缺属性真正稀缺,
	// 又不至于让踩满名额的用户空手(金额照给,只是次日失效)。
	if quotaType == QuotaTypePermanent && tier.DailyWinnerLimit > 0 && tier.Label != "" {
		var won int64
		if err := tx.Model(&model.Draw{}).
			Where("draw_date = ? AND tier_label = ? AND quota_type = ? AND reason IN ?",
				today, tier.Label, QuotaTypePermanent, []string{DrawReasonOK}).
			Count(&won).Error; err != nil {
			return 0, quotaType, "", err
		}
		if won >= int64(tier.DailyWinnerLimit) {
			quotaType = QuotaTypeTemporary
			fallbackReason = DrawReasonJackpotFalback
		}
	}

	// 预算池:抽奖走 draw 池,并计入 total 总闸。锁序 draw -> total,total 恒在最后,
	// 与小游戏的 game -> total 共享「total 排最后」的约定,避免跨路径死锁。
	budgets := drawBudgetRules(gameCfg)
	reward, err = ConsumeBudgetsUpTo(tx, today, wantQuota, budgets, []string{BudgetScopeDraw, BudgetScopeTotal})
	if err != nil {
		return 0, quotaType, "", err
	}
	if reward <= 0 {
		// 中了但当日预算已空:如实记 over_site_budget,不发额度。
		return 0, quotaType, DrawReasonOverBudget, nil
	}
	return reward, quotaType, fallbackReason, nil
}

// drawDefaultBudget 是抽奖预算池在配置缺失时的**保底上限**。
// 抽奖是新功能:存量部署的 game_config 早已落库,其 budgets 里没有 draw 键。
// 若此时按「池不存在=放行」处理,抽奖就成了唯一没有每日上限的发放入口 —— 一个
// 会发永久额度的入口决不能默认无限额。因此键缺失时回落这个启用的保底池。
var drawDefaultBudget = BudgetRule{Enabled: true, Daily: 10000000}

// drawBudgetRules 组装抽奖要用的预算规则表(draw + total)。
// 要扣哪些池由 ConsumeBudgetsUpTo 的 scopes 参数决定,不由这张表的键决定;
// 这里的职责只是**保证 draw 池有一条规则可查**。
//
// draw 池「键存在」与「键不存在」被刻意区分:站长在后台显式关闭(Enabled:false)
// 要被尊重;而存量配置里根本没有这个键,则回落 drawDefaultBudget 保底,不放行成无限额。
func drawBudgetRules(gameCfg *GameConfig) map[string]BudgetRule {
	rules := map[string]BudgetRule{}
	if gameCfg == nil {
		rules[BudgetScopeDraw] = drawDefaultBudget
		return rules
	}
	if r, ok := gameCfg.Budgets[BudgetScopeDraw]; ok {
		rules[BudgetScopeDraw] = r
	} else {
		rules[BudgetScopeDraw] = drawDefaultBudget
	}
	if r, ok := gameCfg.Budgets[BudgetScopeTotal]; ok {
		rules[BudgetScopeTotal] = r
	}
	return rules
}

// GetDrawView 返回抽奖卡片所需的视图数据(GET /api/draw):
// 今日是否已抽、已抽则回其结果、抽奖是否开放、档位表(供前端出奖励说明)。
func (s *DrawService) GetDrawView(cfg *DrawConfig, user *model.User, now time.Time) (map[string]any, error) {
	today := TodayStr(cfg.Timezone, now)

	var todayDraw model.Draw
	drawnToday := false
	err := s.db.Where("user_id = ? AND draw_date = ?", user.ID, today).First(&todayDraw).Error
	if err == nil {
		drawnToday = true
	} else if !errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, err
	}

	view := map[string]any{
		"enabled":     cfg.Enabled,
		"drawn_today": drawnToday,
		"today":       today,
		"tiers":       cfg.Tiers,
	}
	if drawnToday {
		r := drawResultView(&todayDraw)
		// 文案取**当前**档位表(按 roll 反查),而 tier_label 用记录里的快照:
		// 站长改了文案,今天已抽过的人刷新页面会看到新文案,但档位名不会被改写。
		if t, ok := MatchDrawTier(cfg.Tiers, todayDraw.Roll); ok {
			r["quip"] = t.Quip
		}
		view["result"] = r
	}
	return view, nil
}

// drawResultView 把一条 w_draws 记录投影成前端要的结果形状。
func drawResultView(d *model.Draw) map[string]any {
	return map[string]any{
		"roll":       d.Roll,
		"tier_label": d.TierLabel,
		"quota":      d.Quota,
		"quota_type": d.QuotaType,
		"reason":     d.Reason,
		"created_at": d.CreatedAt,
	}
}
