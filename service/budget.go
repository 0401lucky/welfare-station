package service

import (
	"fmt"
	"time"

	"welfare/model"

	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

// maxBudgetUsageDays 限制后台曲线一次最多回看多少天,避免 days 参数被随手填成天文数字。
const maxBudgetUsageDays = 90

// TryConsume 原子扣减某个池的当日预算。返回 false 表示预算不足。
// enabled=false 的池直接放行且不记账。
//
// 扣减必须是**单条**带守卫的 UPDATE:
//
//	UPDATE w_daily_budgets SET used = used + ?, updated_at = ?
//	 WHERE date = ? AND scope = ? AND used + ? <= ?
//
// 判定看 RowsAffected:1 = 扣成功,0 = 预算不足。任何「先 SELECT 当前 used 再在 Go 里
// 比较再写回」的写法在并发下都会击穿预算(两个请求同时读到同一个 used),这是本函数
// 唯一要防的事情,改动时务必保持单语句形态。
//
// 调用方应在结算事务内依次扣来源池与 total 池:后者失败时整个事务回滚,前者的扣减
// 随之撤销,不需要手写补偿逻辑(design.md §6)。
func TryConsume(tx *gorm.DB, date, scope string, amount int64, rule BudgetRule) (bool, error) {
	// scope 一律来自调用方的常量,写错说明是代码 bug。这里选择报错而不是放行:
	// 未知池在配置里查不到规则,取出来是零值 BudgetRule{Enabled:false},会被下面
	// 一行直接放行——于是「池名打错」表现为预算静默失效,而这正是本里程碑要防的。
	// 报错能让它在第一次跑到时就暴露,而不是变成一笔算不清的账。
	if !isKnownBudgetScope(scope) {
		return false, fmt.Errorf("未知的预算池 %s", scope)
	}
	// 池未开启,或压根没有额度要扣(reason != ok 的对局就是 0):放行且不建行,
	// 保持 w_daily_budgets 只记真实发生过的支出。
	if !rule.Enabled || amount <= 0 {
		return true, nil
	}
	if err := ensureBudgetRow(tx, date, scope); err != nil {
		return false, err
	}
	res := tx.Model(&model.DailyBudget{}).
		Where("date = ? AND scope = ? AND used + ? <= ?", date, scope, amount, rule.Daily).
		Updates(map[string]any{
			"used":       gorm.Expr("used + ?", amount),
			"updated_at": time.Now(),
		})
	if res.Error != nil {
		return false, res.Error
	}
	return res.RowsAffected == 1, nil
}

// ConsumeBudgetsUpTo 在一个已经开启的结算事务内，为 game 与 total 两个池
// 计算并扣减共同可用额度。返回值是实际扣减额，可能小于 requested。
//
// 两个池始终按 game -> total 的顺序锁定，避免并发结算以相反顺序取锁形成死锁。
// 读取在行锁内完成，最终 UPDATE 仍保留 used + amount <= daily 守卫：MySQL
// 依靠 FOR UPDATE 串行化，SQLite 等弱锁方言也不会因为调用方误用而静默超发。
func ConsumeBudgetsUpTo(tx *gorm.DB, date string, requested int64, rules map[string]BudgetRule) (int64, error) {
	if requested <= 0 {
		return 0, nil
	}

	remaining := requested
	locked := make([]lockedBudget, 0, 2)
	for _, scope := range []string{BudgetScopeGame, BudgetScopeTotal} {
		rule := rules[scope]
		if !rule.Enabled {
			continue
		}
		if !isKnownBudgetScope(scope) {
			return 0, fmt.Errorf("未知的预算池 %s", scope)
		}
		if err := ensureBudgetRow(tx, date, scope); err != nil {
			return 0, err
		}

		var row model.DailyBudget
		query := tx.Clauses(clause.Locking{Strength: "UPDATE"}).
			Where("date = ? AND scope = ?", date, scope).First(&row)
		if query.Error != nil {
			return 0, query.Error
		}
		available := rule.Daily - row.Used
		if available < 0 {
			available = 0
		}
		if available < remaining {
			remaining = available
		}
		locked = append(locked, lockedBudget{scope: scope, rule: rule})
	}

	if remaining <= 0 {
		return 0, nil
	}
	for _, budget := range locked {
		res := tx.Model(&model.DailyBudget{}).
			Where("date = ? AND scope = ? AND used + ? <= ?",
				date, budget.scope, remaining, budget.rule.Daily).
			Updates(map[string]any{
				"used":       gorm.Expr("used + ?", remaining),
				"updated_at": time.Now(),
			})
		if res.Error != nil {
			return 0, res.Error
		}
		if res.RowsAffected != 1 {
			return 0, fmt.Errorf("预算池 %s 在锁定后仍无法扣减", budget.scope)
		}
	}
	return remaining, nil
}

type lockedBudget struct {
	scope string
	rule  BudgetRule
}

// ensureBudgetRow 保证当日该池的行存在。并发下两个 insert 只有一个能成功,
// 撞唯一键属正常情况,不当作错误。
func ensureBudgetRow(tx *gorm.DB, date, scope string) error {
	row := model.DailyBudget{Date: date, Scope: scope, Used: 0, UpdatedAt: time.Now()}
	err := tx.Clauses(clause.OnConflict{DoNothing: true}).Create(&row).Error
	if err != nil && isDuplicateErr(err) {
		return nil
	}
	return err
}

// BudgetDayUsage 是某一天各池的已用量。Used 里四个池必然齐全,当日没有记录的池记 0,
// 前端不必区分「没花过」和「没这个池」。
type BudgetDayUsage struct {
	Date string           `json:"date"`
	Used map[string]int64 `json:"used"` // key = scope(total|game|checkin|activity)
}

// BudgetUsage 返回近 days 天(含今日)各池的已用量,按日期升序,最后一项就是今日。
// 供后台 GET /api/admin/budgets?days=7 展示今日用量与近期曲线;预算上限在配置里,
// 由调用方自行取 GameConfig.Budgets 合并。
// timezone 决定日界,与 TryConsume 用的是同一套 TodayStr。
func BudgetUsage(db *gorm.DB, timezone string, days int, now time.Time) ([]BudgetDayUsage, error) {
	if days < 1 {
		days = 1
	}
	if days > maxBudgetUsageDays {
		days = maxBudgetUsageDays
	}

	dates := make([]string, 0, days)
	for i := days - 1; i >= 0; i-- {
		dates = append(dates, TodayStr(timezone, now.AddDate(0, 0, -i)))
	}

	var rows []model.DailyBudget
	if err := db.Where("date IN ?", dates).Find(&rows).Error; err != nil {
		return nil, err
	}
	// (date, scope) 是主键,一天一个池至多一行,直接铺平成查找表。
	used := make(map[string]int64, len(rows))
	for _, r := range rows {
		used[r.Date+"|"+r.Scope] = r.Used
	}

	out := make([]BudgetDayUsage, 0, len(dates))
	for _, d := range dates {
		day := BudgetDayUsage{Date: d, Used: make(map[string]int64, len(BudgetScopes))}
		for _, scope := range BudgetScopes {
			day.Used[scope] = used[d+"|"+scope]
		}
		out = append(out, day)
	}
	return out, nil
}
