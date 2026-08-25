package service

import (
	"context"
	"strings"
	"sync"
	"testing"
	"time"

	"welfare/model"

	"gorm.io/gorm"
	"gorm.io/gorm/logger"
)

const budgetTestDate = "2026-08-20"

// countBudgetRows 数 w_daily_budgets 的行数,用来验证「放行的分支不记账」。
func countBudgetRows(t *testing.T, db *gorm.DB) int64 {
	t.Helper()
	var n int64
	if err := db.Model(&model.DailyBudget{}).Count(&n).Error; err != nil {
		t.Fatalf("count budget rows: %v", err)
	}
	return n
}

// budgetUsed 读某日某池的已用量;没有行按 0 处理。
func budgetUsed(t *testing.T, db *gorm.DB, date, scope string) int64 {
	t.Helper()
	var row model.DailyBudget
	err := db.Where("date = ? AND scope = ?", date, scope).First(&row).Error
	if err == gorm.ErrRecordNotFound {
		return 0
	}
	if err != nil {
		t.Fatalf("load budget row: %v", err)
	}
	return row.Used
}

// TestBudgetExhausted 覆盖单池耗尽后拒绝:预算 100,扣 60 成功、再扣 60 失败,
// used 停在 60(失败的那笔一分都不能扣走,不做部分发放)。
func TestBudgetExhausted(t *testing.T) {
	db := grantDB(t)
	rule := BudgetRule{Enabled: true, Daily: 100}

	ok, err := TryConsume(db, budgetTestDate, BudgetScopeGame, 60, rule)
	if err != nil || !ok {
		t.Fatalf("首次扣 60 应当成功: ok=%v err=%v", ok, err)
	}
	if got := budgetUsed(t, db, budgetTestDate, BudgetScopeGame); got != 60 {
		t.Fatalf("used: got %d, want 60", got)
	}

	ok, err = TryConsume(db, budgetTestDate, BudgetScopeGame, 60, rule)
	if err != nil {
		t.Fatalf("预算不足应当返回 false 而不是报错: %v", err)
	}
	if ok {
		t.Fatalf("剩余 40 时扣 60 必须被拒")
	}
	if got := budgetUsed(t, db, budgetTestDate, BudgetScopeGame); got != 60 {
		t.Fatalf("被拒后 used 不能变化: got %d, want 60", got)
	}

	// 正好扣满边界:剩 40 时扣 40 必须放行(守卫是 <=,不是 <)。
	ok, err = TryConsume(db, budgetTestDate, BudgetScopeGame, 40, rule)
	if err != nil || !ok {
		t.Fatalf("正好扣满应当成功: ok=%v err=%v", ok, err)
	}
	if got := budgetUsed(t, db, budgetTestDate, BudgetScopeGame); got != 100 {
		t.Fatalf("used: got %d, want 100", got)
	}
}

// TestConsumeBudgetsUpToPartial verifies that game and total use the same
// actual amount and that a smaller remaining pool truncates the payout.
func TestConsumeBudgetsUpToPartial(t *testing.T) {
	db := grantDB(t)
	rules := map[string]BudgetRule{
		BudgetScopeGame:  {Enabled: true, Daily: 500},
		BudgetScopeTotal: {Enabled: true, Daily: 800},
	}

	got, err := ConsumeBudgetsUpTo(db, budgetTestDate, 1000, rules, []string{BudgetScopeGame, BudgetScopeTotal})
	if err != nil || got != 500 {
		t.Fatalf("共同额度应截断到 game 剩余 500: got=%d err=%v", got, err)
	}
	if used := budgetUsed(t, db, budgetTestDate, BudgetScopeGame); used != 500 {
		t.Errorf("game used: got %d, want 500", used)
	}
	if used := budgetUsed(t, db, budgetTestDate, BudgetScopeTotal); used != 500 {
		t.Errorf("total used: got %d, want 500", used)
	}

	got, err = ConsumeBudgetsUpTo(db, budgetTestDate, 1, rules, []string{BudgetScopeGame, BudgetScopeTotal})
	if err != nil || got != 0 {
		t.Fatalf("game 已耗尽后不应继续发放: got=%d err=%v", got, err)
	}
}

// TestConsumeBudgetsUpToConcurrent checks the aggregate invariant for partial
// payouts: concurrent requests may split the final remainder, but never exceed
// either pool's configured daily budget.
func TestConsumeBudgetsUpToConcurrent(t *testing.T) {
	db := grantDB(t)
	rules := map[string]BudgetRule{
		BudgetScopeGame:  {Enabled: true, Daily: 100},
		BudgetScopeTotal: {Enabled: true, Daily: 100},
	}

	const workers = 20
	results := make([]int64, workers)
	errs := make([]error, workers)
	var wg sync.WaitGroup
	start := make(chan struct{})
	for i := 0; i < workers; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			<-start
			results[i], errs[i] = consumeBudgetsUpToInTx(db, budgetTestDate, 100, rules)
		}(i)
	}
	close(start)
	wg.Wait()

	var total int64
	for i, amount := range results {
		if errs[i] != nil {
			t.Fatalf("goroutine %d: %v", i, errs[i])
		}
		total += amount
	}
	if total != 100 {
		t.Fatalf("并发部分扣减总额应恰好 100,实际 %d", total)
	}
	if got := budgetUsed(t, db, budgetTestDate, BudgetScopeGame); got != 100 {
		t.Errorf("game used: got %d, want 100", got)
	}
	if got := budgetUsed(t, db, budgetTestDate, BudgetScopeTotal); got != 100 {
		t.Errorf("total used: got %d, want 100", got)
	}
}

func consumeBudgetsUpToInTx(db *gorm.DB, date string, requested int64, rules map[string]BudgetRule) (int64, error) {
	var lastErr error
	for attempt := 0; attempt < 200; attempt++ {
		var got int64
		err := db.Transaction(func(tx *gorm.DB) error {
			var err error
			got, err = ConsumeBudgetsUpTo(tx, date, requested, rules, []string{BudgetScopeGame, BudgetScopeTotal})
			return err
		})
		if err == nil {
			return got, nil
		}
		if !isLockedErr(err) {
			return 0, err
		}
		lastErr = err
		time.Sleep(time.Millisecond)
	}
	return 0, lastErr
}

// TestBudgetDisabledPool 覆盖 enabled=false 的池永远放行,且完全不记账。
func TestBudgetDisabledPool(t *testing.T) {
	db := grantDB(t)
	rule := BudgetRule{Enabled: false, Daily: 1}

	ok, err := TryConsume(db, budgetTestDate, BudgetScopeTotal, 999999999, rule)
	if err != nil || !ok {
		t.Fatalf("未开启的池应当放行: ok=%v err=%v", ok, err)
	}
	if n := countBudgetRows(t, db); n != 0 {
		t.Fatalf("未开启的池不能建行,w_daily_budgets 里却有 %d 行", n)
	}
}

// TestBudgetZeroAndNegativeAmount 覆盖 amount <= 0 直接放行且不记账。
// 结算里 reason != ok 的对局 quota 就是 0,不该在预算表里留痕。
func TestBudgetZeroAndNegativeAmount(t *testing.T) {
	db := grantDB(t)
	rule := BudgetRule{Enabled: true, Daily: 100}

	for _, amount := range []int64{0, -1} {
		ok, err := TryConsume(db, budgetTestDate, BudgetScopeGame, amount, rule)
		if err != nil || !ok {
			t.Fatalf("amount=%d 应当放行: ok=%v err=%v", amount, ok, err)
		}
	}
	if n := countBudgetRows(t, db); n != 0 {
		t.Fatalf("amount<=0 不能建行,w_daily_budgets 里却有 %d 行", n)
	}
}

// TestBudgetUnknownScope 锁住未知池名的行为:报错,且不建行。
//
// 选择报错而不是放行的理由见 budget.go 的注释:scope 全部来自调用方常量,写错时
// 配置里查不到规则会得到零值 BudgetRule{Enabled:false},若放行就等于「池名打错 →
// 预算静默失效」,而这正是本里程碑要防的事故。报错让它第一次跑到就暴露。
func TestBudgetUnknownScope(t *testing.T) {
	db := grantDB(t)

	ok, err := TryConsume(db, budgetTestDate, "lottery", 10, BudgetRule{Enabled: true, Daily: 100})
	if err == nil {
		t.Fatalf("未知池名必须报错")
	}
	if ok {
		t.Fatalf("未知池名不能放行")
	}
	if !strings.Contains(err.Error(), "lottery") {
		t.Errorf("错误信息应当点出池名,got: %v", err)
	}
	// 池未开启也一样要报错——否则打错的池名会被 enabled=false 静默吞掉。
	if _, err := TryConsume(db, budgetTestDate, "lottery", 10, BudgetRule{}); err == nil {
		t.Errorf("未开启的未知池同样必须报错")
	}
	if n := countBudgetRows(t, db); n != 0 {
		t.Fatalf("未知池不能建行,w_daily_budgets 里却有 %d 行", n)
	}
}

// TestBudgetResetsAcrossDays 覆盖跨日重置:换一个 date 后额度完全恢复,
// 且不影响前一天的账。
func TestBudgetResetsAcrossDays(t *testing.T) {
	db := grantDB(t)
	rule := BudgetRule{Enabled: true, Daily: 100}

	if ok, err := TryConsume(db, budgetTestDate, BudgetScopeGame, 100, rule); err != nil || !ok {
		t.Fatalf("第一天扣满应当成功: ok=%v err=%v", ok, err)
	}
	if ok, err := TryConsume(db, budgetTestDate, BudgetScopeGame, 1, rule); err != nil || ok {
		t.Fatalf("第一天扣满后应当拒绝: ok=%v err=%v", ok, err)
	}

	const nextDay = "2026-08-21"
	if ok, err := TryConsume(db, nextDay, BudgetScopeGame, 100, rule); err != nil || !ok {
		t.Fatalf("次日额度应当完全恢复: ok=%v err=%v", ok, err)
	}
	if got := budgetUsed(t, db, budgetTestDate, BudgetScopeGame); got != 100 {
		t.Errorf("前一天的账不能被改动: got %d, want 100", got)
	}
	if got := budgetUsed(t, db, nextDay, BudgetScopeGame); got != 100 {
		t.Errorf("次日 used: got %d, want 100", got)
	}
}

// TestBudgetScopesAreIndependent 覆盖两级扣减的前提:各池互不影响,
// game 池扣满不该动到 total 池。
func TestBudgetScopesAreIndependent(t *testing.T) {
	db := grantDB(t)
	rule := BudgetRule{Enabled: true, Daily: 100}

	if ok, err := TryConsume(db, budgetTestDate, BudgetScopeGame, 100, rule); err != nil || !ok {
		t.Fatalf("game 池扣满应当成功: ok=%v err=%v", ok, err)
	}
	if ok, err := TryConsume(db, budgetTestDate, BudgetScopeTotal, 100, rule); err != nil || !ok {
		t.Fatalf("total 池应当仍有全额: ok=%v err=%v", ok, err)
	}
	if got := budgetUsed(t, db, budgetTestDate, BudgetScopeGame); got != 100 {
		t.Errorf("game used: got %d, want 100", got)
	}
	if got := budgetUsed(t, db, budgetTestDate, BudgetScopeTotal); got != 100 {
		t.Errorf("total used: got %d, want 100", got)
	}
}

// TestBudgetConcurrentNoOverspend 是本里程碑的核心用例(AC9):
// 预算只够 1 份,20 个 goroutine 各用独立事务同时抢,必须恰好 1 个成功、used 恰好等于预算。
//
// 注意本用例的检测力有边界(实测结论,勿高估):SQLite 的写事务是全库互斥的,把
// TryConsume 换成读-改-写后本用例**仍然会通过**——SELECT 与 UPDATE 被裹在同一个
// 串行化的写事务里,压根没机会交错;只有在两者之间人为插入 20ms 才能让它翻车
// (那时 20 个 goroutine 全部成功)。真正在 MySQL 上会超发的读-改-写,在这个夹具上
// 测不出来。
//
// 因此语句形状由 TestBudgetUsesSingleGuardedUpdate 确定性地守住(禁 SELECT + 强制
// `used + ? <= ?` 守卫),本用例守的是行为契约:恰好 1 个成功、used 恰好等于预算、
// 并发建行不多出行。两个用例缺一不可。
func TestBudgetConcurrentNoOverspend(t *testing.T) {
	db := grantDB(t)
	rule := BudgetRule{Enabled: true, Daily: 100}

	const workers = 20
	var wg sync.WaitGroup
	results := make([]bool, workers)
	errs := make([]error, workers)
	start := make(chan struct{})

	for i := 0; i < workers; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			<-start
			// 每个 goroutine 独立事务,模拟并发结算。
			results[i], errs[i] = consumeInTx(db, budgetTestDate, BudgetScopeGame, 100, rule)
		}(i)
	}
	close(start) // 尽量让 20 个请求挤在同一瞬间
	wg.Wait()

	successes := 0
	for i, ok := range results {
		if errs[i] != nil {
			t.Fatalf("goroutine %d 扣减报错: %v", i, errs[i])
		}
		if ok {
			successes++
		}
	}
	if successes != 1 {
		t.Fatalf("并发抢最后一份:成功次数 = %d, want 恰好 1(超发说明扣减不是原子的)", successes)
	}
	if got := budgetUsed(t, db, budgetTestDate, BudgetScopeGame); got != 100 {
		t.Fatalf("used = %d, want 恰好 100", got)
	}
	// 建行也是并发的,不能因为抢建而多出行来。
	if n := countBudgetRows(t, db); n != 1 {
		t.Fatalf("w_daily_budgets 应当只有 1 行,实际 %d 行", n)
	}
}

// consumeInTx 在独立事务里扣一次预算。SQLite 的写事务是互斥的,拿不到锁时会直接报
// "database is locked" —— 那是测试夹具的排队问题,不是预算逻辑的结论,退避后重来。
// 干净的 (false, nil) 是最终结论(预算不足),不重试。
func consumeInTx(db *gorm.DB, date, scope string, amount int64, rule BudgetRule) (bool, error) {
	var lastErr error
	for attempt := 0; attempt < 200; attempt++ {
		var ok bool
		err := db.Transaction(func(tx *gorm.DB) error {
			var innerErr error
			ok, innerErr = TryConsume(tx, date, scope, amount, rule)
			return innerErr
		})
		if err == nil {
			return ok, nil
		}
		if !isLockedErr(err) {
			return false, err
		}
		lastErr = err
		time.Sleep(time.Millisecond)
	}
	return false, lastErr
}

func isLockedErr(err error) bool {
	s := strings.ToLower(err.Error())
	return strings.Contains(s, "locked") || strings.Contains(s, "busy")
}

// TestBudgetUsesSingleGuardedUpdate 锁死扣减的语句形状:一条带
// `used + ? <= ?` 守卫的 UPDATE,全程不出现 SELECT。这是并发正确性的来源,
// 任何把它拆成读-改-写的重构都会在这里被挡下。
func TestBudgetUsesSingleGuardedUpdate(t *testing.T) {
	db := grantDB(t)
	// 先建好行,把 ensureBudgetRow 的 INSERT 排除在观察范围外。
	if ok, err := TryConsume(db, budgetTestDate, BudgetScopeGame, 1, BudgetRule{Enabled: true, Daily: 100}); err != nil || !ok {
		t.Fatalf("预热: ok=%v err=%v", ok, err)
	}

	rec := &sqlRecorder{}
	session := db.Session(&gorm.Session{Logger: rec})
	if ok, err := TryConsume(session, budgetTestDate, BudgetScopeGame, 1, BudgetRule{Enabled: true, Daily: 100}); err != nil || !ok {
		t.Fatalf("观察扣减: ok=%v err=%v", ok, err)
	}

	var updates []string
	for _, sql := range rec.recorded() {
		up := strings.ToUpper(sql)
		if strings.Contains(up, "SELECT") {
			t.Errorf("扣减路径不允许出现 SELECT(读-改-写会击穿预算): %s", sql)
		}
		if strings.HasPrefix(strings.TrimSpace(up), "UPDATE") {
			updates = append(updates, sql)
		}
	}
	if len(updates) != 1 {
		t.Fatalf("扣减必须是单条 UPDATE,实际 %d 条: %v", len(updates), updates)
	}
	// 守卫必须长在 WHERE 里。只看整条语句是不够的:`SET used = used + 1` 同样含
	// "used + ",把 WHERE 的守卫删掉照样能蒙混过关,而那正是击穿预算的写法。
	_, where, found := strings.Cut(updates[0], "WHERE")
	if !found {
		t.Fatalf("扣减 UPDATE 必须带 WHERE,实际: %s", updates[0])
	}
	if !strings.Contains(where, "used + ") || !strings.Contains(where, "<=") {
		t.Errorf("WHERE 必须带 `used + ? <= ?` 守卫,实际 WHERE: %s", where)
	}
	t.Logf("扣减 SQL: %s", updates[0])
}

// TestConsumeBudgetsUpToUsesGuardedUpdates 锁住两池共同扣减路径的 SQL 形状：
// 读取余额可以用 FOR UPDATE，但最终每个启用池都必须用带 used + ? <= ?
// 守卫的单条 UPDATE，避免后续重构退回读-改-写。
func TestConsumeBudgetsUpToUsesGuardedUpdates(t *testing.T) {
	db := grantDB(t)
	rules := map[string]BudgetRule{
		BudgetScopeGame:  {Enabled: true, Daily: 100},
		BudgetScopeTotal: {Enabled: true, Daily: 100},
	}
	// 预热行，排除首次建行的 INSERT。
	if _, err := ConsumeBudgetsUpTo(db, budgetTestDate, 1, rules, []string{BudgetScopeGame, BudgetScopeTotal}); err != nil {
		t.Fatalf("预热: %v", err)
	}

	rec := &sqlRecorder{}
	session := db.Session(&gorm.Session{Logger: rec})
	var got int64
	err := session.Transaction(func(tx *gorm.DB) error {
		var err error
		got, err = ConsumeBudgetsUpTo(tx, budgetTestDate, 1, rules, []string{BudgetScopeGame, BudgetScopeTotal})
		return err
	})
	if err != nil || got != 1 {
		t.Fatalf("观察扣减: got=%d err=%v", got, err)
	}

	var updates []string
	for _, sql := range rec.recorded() {
		up := strings.ToUpper(sql)
		if strings.HasPrefix(strings.TrimSpace(up), "UPDATE") {
			updates = append(updates, up)
		}
	}
	if len(updates) != 2 {
		t.Fatalf("两池各应执行一条 UPDATE,实际 %d 条: %v", len(updates), updates)
	}
	for _, update := range updates {
		_, where, found := strings.Cut(update, "WHERE")
		if !found || !strings.Contains(where, "USED + ") || !strings.Contains(where, "<=") {
			t.Errorf("预算 UPDATE 必须带 used + ? <= ? 守卫,实际: %s", update)
		}
	}
}

// sqlRecorder 是只记录 SQL 的 gorm logger。
type sqlRecorder struct {
	mu   sync.Mutex
	sqls []string
}

func (r *sqlRecorder) LogMode(logger.LogLevel) logger.Interface { return r }
func (r *sqlRecorder) Info(context.Context, string, ...any)     {}
func (r *sqlRecorder) Warn(context.Context, string, ...any)     {}
func (r *sqlRecorder) Error(context.Context, string, ...any)    {}
func (r *sqlRecorder) Trace(_ context.Context, _ time.Time, fc func() (string, int64), _ error) {
	sql, _ := fc()
	r.mu.Lock()
	r.sqls = append(r.sqls, sql)
	r.mu.Unlock()
}

func (r *sqlRecorder) recorded() []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]string(nil), r.sqls...)
}

// TestBudgetUsage 覆盖后台展示:按日期升序、四个池齐全、没记录的池是 0 不是缺项。
func TestBudgetUsage(t *testing.T) {
	db := grantDB(t)
	tz := "Asia/Shanghai"
	now := time.Now()
	today := TodayStr(tz, now)
	yesterday := TodayStr(tz, now.AddDate(0, 0, -1))

	rule := BudgetRule{Enabled: true, Daily: 1000}
	if ok, err := TryConsume(db, today, BudgetScopeGame, 300, rule); err != nil || !ok {
		t.Fatalf("today game: ok=%v err=%v", ok, err)
	}
	if ok, err := TryConsume(db, yesterday, BudgetScopeTotal, 700, rule); err != nil || !ok {
		t.Fatalf("yesterday total: ok=%v err=%v", ok, err)
	}

	days, err := BudgetUsage(db, tz, 3, now)
	if err != nil {
		t.Fatalf("BudgetUsage: %v", err)
	}
	if len(days) != 3 {
		t.Fatalf("应当返回 3 天,实际 %d 天", len(days))
	}
	if days[2].Date != today {
		t.Errorf("最后一项应当是今日 %s,实际 %s", today, days[2].Date)
	}
	if days[1].Date != yesterday {
		t.Errorf("倒数第二项应当是昨日 %s,实际 %s", yesterday, days[1].Date)
	}
	for _, d := range days {
		if len(d.Used) != len(BudgetScopes) {
			t.Errorf("%s 缺池: %v", d.Date, d.Used)
		}
		for _, scope := range BudgetScopes {
			if _, ok := d.Used[scope]; !ok {
				t.Errorf("%s 缺池 %s(没记录也要给 0)", d.Date, scope)
			}
		}
	}
	if days[2].Used[BudgetScopeGame] != 300 {
		t.Errorf("今日 game used: got %d, want 300", days[2].Used[BudgetScopeGame])
	}
	if days[2].Used[BudgetScopeTotal] != 0 {
		t.Errorf("今日 total 没花过应当是 0, got %d", days[2].Used[BudgetScopeTotal])
	}
	if days[1].Used[BudgetScopeTotal] != 700 {
		t.Errorf("昨日 total used: got %d, want 700", days[1].Used[BudgetScopeTotal])
	}
	if days[0].Used[BudgetScopeGame] != 0 {
		t.Errorf("前日没有任何记录,应当整天为 0, got %d", days[0].Used[BudgetScopeGame])
	}

	// days 参数越界要被夹住,不能穿透成一个天文数字的查询。
	if got, err := BudgetUsage(db, tz, 0, now); err != nil || len(got) != 1 {
		t.Errorf("days=0 应当夹成 1 天, got %d 天 err=%v", len(got), err)
	}
	if got, err := BudgetUsage(db, tz, 10000, now); err != nil || len(got) != maxBudgetUsageDays {
		t.Errorf("days 过大应当夹到 %d 天, got %d 天 err=%v", maxBudgetUsageDays, len(got), err)
	}
}
