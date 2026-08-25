package service

import (
	"errors"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"welfare/model"

	"gorm.io/gorm"
)

// drawTestUser 建一个已绑定 new-api 的用户。抽奖要求已绑定,否则中奖没处发。
func drawTestUser(t *testing.T, db *gorm.DB) *model.User {
	t.Helper()
	newapiID := int64(42)
	u := &model.User{
		LinuxDOID:    "draw-tester",
		LinuxDOName:  "tester",
		NewapiUserID: &newapiID,
		Status:       1,
	}
	if err := db.Create(u).Error; err != nil {
		t.Fatalf("create user: %v", err)
	}
	return u
}

// singleTierConfig 造一个「必中某档」的配置:唯一档位铺满 1-100,
// 于是 roll 落在哪都命中它,测试不必与随机数打架。
func singleTierConfig(tier DrawTier) *DrawConfig {
	tier.RollMin, tier.RollMax = 1, 100
	return &DrawConfig{Enabled: true, Timezone: "Asia/Shanghai", Tiers: []DrawTier{tier}}
}

// budgetsFor 造一份只开 draw 池的预算配置。
func budgetsFor(daily int64) *GameConfig {
	return &GameConfig{
		Timezone: "Asia/Shanghai",
		Budgets: map[string]BudgetRule{
			BudgetScopeDraw:  {Enabled: true, Daily: daily},
			BudgetScopeTotal: {Enabled: false, Daily: 0},
		},
	}
}

// TestMatchDrawTierCoversWholeRange 验证默认档位表对 1-100 每个数字都能命中且只命中一档。
// 这是抽奖的核心不变式:漏掉任何一个数字,那 1% 的用户就会摇出一次静默失败的抽奖。
func TestMatchDrawTierCoversWholeRange(t *testing.T) {
	cfg := DefaultDrawConfig(5000000)
	for roll := 1; roll <= 100; roll++ {
		hits := 0
		for _, tier := range cfg.Tiers {
			if roll >= tier.RollMin && roll <= tier.RollMax {
				hits++
			}
		}
		if hits != 1 {
			t.Fatalf("roll %d 命中 %d 档,应恰好命中 1 档", roll, hits)
		}
		if _, ok := MatchDrawTier(cfg.Tiers, roll); !ok {
			t.Fatalf("roll %d 没有命中任何档位", roll)
		}
	}
}

// TestDefaultDrawConfigTierShape 锁定与用户确认的「大奖低频」方案:
// 90% 无额度、8% 限时中奖、2% 永久大奖。
func TestDefaultDrawConfigTierShape(t *testing.T) {
	cfg := DefaultDrawConfig(50000000) // 上限给足,不触发夹取
	if len(cfg.Tiers) != 3 {
		t.Fatalf("默认档位应为 3 档,实际 %d", len(cfg.Tiers))
	}
	none, mid, jackpot := cfg.Tiers[0], cfg.Tiers[1], cfg.Tiers[2]

	if none.RollMin != 1 || none.RollMax != 90 || none.MaxQuota != 0 {
		t.Fatalf("无奖档应是 1-90 且无额度,实际 %+v", none)
	}
	if mid.RollMin != 91 || mid.RollMax != 98 || mid.RewardType != QuotaTypeTemporary {
		t.Fatalf("中奖档应是 91-98 限时额度,实际 %+v", mid)
	}
	if jackpot.RollMin != 99 || jackpot.RollMax != 100 || jackpot.RewardType != QuotaTypePermanent {
		t.Fatalf("大奖档应是 99-100 永久额度,实际 %+v", jackpot)
	}
	if jackpot.DailyWinnerLimit <= 0 {
		t.Fatal("永久大奖档必须配全站每日名额,否则永久额度失去稀缺性")
	}
}

// TestDefaultDrawConfigClampedByMaxGrant 验证默认值被单次发放上限夹住。
// 不夹的话开箱默认配置连自己的校验都过不了 —— 站长进后台什么都不改点保存就报错。
func TestDefaultDrawConfigClampedByMaxGrant(t *testing.T) {
	const maxGrant = 5000000 // $10
	cfg := DefaultDrawConfig(maxGrant)
	for _, tier := range cfg.Tiers {
		if tier.MaxQuota > maxGrant {
			t.Fatalf("档位「%s」额度上界 %d 超过单次发放上限 %d", tier.Label, tier.MaxQuota, maxGrant)
		}
	}
	// 夹过之后必须仍能通过 SaveDrawConfig 的校验。
	db := grantDB(t)
	if err := SaveDrawConfig(db, cfg, maxGrant); err != nil {
		t.Fatalf("默认配置应当可以直接保存,却被拒绝: %v", err)
	}
}

// TestSaveDrawConfigRejectsGappedTiers 验证区间有洞/重叠/越界的档位表被拒绝。
func TestSaveDrawConfigRejectsGappedTiers(t *testing.T) {
	db := grantDB(t)
	cases := []struct {
		name  string
		tiers []DrawTier
	}{
		{"漏掉 99", []DrawTier{
			{Label: "无", RollMin: 1, RollMax: 98},
			{Label: "大奖", RollMin: 100, RollMax: 100},
		}},
		{"区间重叠", []DrawTier{
			{Label: "无", RollMin: 1, RollMax: 95},
			{Label: "大奖", RollMin: 90, RollMax: 100},
		}},
		{"没铺到 100", []DrawTier{
			{Label: "无", RollMin: 1, RollMax: 90},
		}},
		{"不从 1 开始", []DrawTier{
			{Label: "无", RollMin: 2, RollMax: 100},
		}},
		{"空档位表", nil},
	}
	for _, tc := range cases {
		cfg := &DrawConfig{Enabled: true, Timezone: "Asia/Shanghai", Tiers: tc.tiers}
		if err := SaveDrawConfig(db, cfg, 5000000); err == nil {
			t.Fatalf("%s:应当被拒绝,却保存成功", tc.name)
		}
	}
}

// TestSaveDrawConfigRejectsOverMaxGrant 验证天价奖励被单次发放上限挡住。
func TestSaveDrawConfigRejectsOverMaxGrant(t *testing.T) {
	db := grantDB(t)
	cfg := singleTierConfig(DrawTier{
		Label: "天价", RewardType: QuotaTypePermanent, MinQuota: 1, MaxQuota: 999999999,
	})
	if err := SaveDrawConfig(db, cfg, 5000000); err == nil {
		t.Fatal("超过单次发放上限的档位应当被拒绝")
	}
}

// TestDoDrawOncePerDay 验证每人每天只能抽一次:第二次直接 ErrAlreadyDrawn。
func TestDoDrawOncePerDay(t *testing.T) {
	svc, mock, db := setupGrantService(t)
	defer mock.Close()
	drawSvc := NewDrawService(db, svc)
	user := drawTestUser(t, db)

	cfg := singleTierConfig(DrawTier{Label: "无奖", RewardType: QuotaTypeTemporary})
	gameCfg := budgetsFor(10000000)

	if _, err := drawSvc.DoDraw(cfg, gameCfg, user); err != nil {
		t.Fatalf("首次抽奖应成功: %v", err)
	}
	_, err := drawSvc.DoDraw(cfg, gameCfg, user)
	if !errors.Is(err, ErrAlreadyDrawn) {
		t.Fatalf("第二次抽奖应返回 ErrAlreadyDrawn,实际 %v", err)
	}

	var count int64
	db.Model(&model.Draw{}).Where("user_id = ?", user.ID).Count(&count)
	if count != 1 {
		t.Fatalf("应只有 1 条抽奖记录,实际 %d", count)
	}
}

// TestDoDrawConcurrentOnlyOneWins 验证并发抽奖只有一次成功(uk_user_draw_date),
// 且**预算不会被失败的那次吃掉** —— 这是把预算扣减放进同一事务的理由。
func TestDoDrawConcurrentOnlyOneWins(t *testing.T) {
	svc, mock, db := setupGrantService(t)
	defer mock.Close()
	drawSvc := NewDrawService(db, svc)
	user := drawTestUser(t, db)

	const prize = 1000000
	cfg := singleTierConfig(DrawTier{
		Label: "必中", RewardType: QuotaTypeTemporary, MinQuota: prize, MaxQuota: prize,
	})
	gameCfg := budgetsFor(10000000)

	const racers = 6
	var okCount, dupCount int64
	var wg sync.WaitGroup
	start := make(chan struct{})
	for i := 0; i < racers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			_, err := drawSvc.DoDraw(cfg, gameCfg, user)
			switch {
			case err == nil:
				atomic.AddInt64(&okCount, 1)
			case errors.Is(err, ErrAlreadyDrawn):
				atomic.AddInt64(&dupCount, 1)
			}
		}()
	}
	close(start)
	wg.Wait()

	if okCount != 1 {
		t.Fatalf("并发抽奖应恰好 1 次成功,实际 %d 次(重复 %d)", okCount, dupCount)
	}
	var rows int64
	db.Model(&model.Draw{}).Where("user_id = ?", user.ID).Count(&rows)
	if rows != 1 {
		t.Fatalf("应只有 1 条抽奖记录,实际 %d", rows)
	}
	// 预算只应被成功的那一次扣掉一份。失败的并发若吃了预算,这里就会大于 prize。
	today := TodayStr(cfg.Timezone, time.Now())
	var budget model.DailyBudget
	if err := db.Where("date = ? AND scope = ?", today, BudgetScopeDraw).First(&budget).Error; err != nil {
		t.Fatalf("读取预算用量: %v", err)
	}
	if budget.Used != prize {
		t.Fatalf("预算应只被扣一份 %d,实际 %d —— 失败的并发抽奖吃掉了预算", prize, budget.Used)
	}
}

// TestDoDrawBudgetExhausted 验证当日预算耗尽时:幸运数字照常给,但不发额度,
// 并如实记 over_site_budget(而不是假装没中奖)。
func TestDoDrawBudgetExhausted(t *testing.T) {
	svc, mock, db := setupGrantService(t)
	defer mock.Close()
	drawSvc := NewDrawService(db, svc)

	cfg := singleTierConfig(DrawTier{
		Label: "必中", RewardType: QuotaTypeTemporary, MinQuota: 1000000, MaxQuota: 1000000,
	})
	// 预算只够一个人中奖。
	gameCfg := budgetsFor(1000000)

	first := drawTestUser(t, db)
	res1, err := drawSvc.DoDraw(cfg, gameCfg, first)
	if err != nil {
		t.Fatalf("第一次抽奖: %v", err)
	}
	if res1.Draw.Quota != 1000000 || res1.Draw.Reason != DrawReasonOK {
		t.Fatalf("第一人应正常中奖,实际 quota=%d reason=%s", res1.Draw.Quota, res1.Draw.Reason)
	}

	// 第二个用户:预算已空。
	newapiID := int64(43)
	second := &model.User{LinuxDOID: "second", LinuxDOName: "b", NewapiUserID: &newapiID, Status: 1}
	if err := db.Create(second).Error; err != nil {
		t.Fatalf("create second user: %v", err)
	}
	res2, err := drawSvc.DoDraw(cfg, gameCfg, second)
	if err != nil {
		t.Fatalf("第二次抽奖不应报错(记录仍要写下): %v", err)
	}
	if res2.Draw.Quota != 0 {
		t.Fatalf("预算耗尽时不应发额度,实际 %d", res2.Draw.Quota)
	}
	if res2.Draw.Reason != DrawReasonOverBudget {
		t.Fatalf("应如实记 over_site_budget,实际 %s", res2.Draw.Reason)
	}
	if res2.Grant != nil {
		t.Fatal("预算耗尽时不应产生发放流水")
	}
	// 幸运数字仍在合法区间:用户照样看到今日运气。
	if res2.Draw.Roll < 1 || res2.Draw.Roll > 100 {
		t.Fatalf("幸运数字应在 1-100,实际 %d", res2.Draw.Roll)
	}
}

// TestDoDrawJackpotFallbackToTemporary 验证永久大奖名额满后降级为限时额度:
// 金额照给,但额度类型降级,原因记 jackpot_fallback。
func TestDoDrawJackpotFallbackToTemporary(t *testing.T) {
	svc, mock, db := setupGrantService(t)
	defer mock.Close()
	drawSvc := NewDrawService(db, svc)

	cfg := singleTierConfig(DrawTier{
		Label:            "欧皇附体",
		RewardType:       QuotaTypePermanent,
		MinQuota:         1000000,
		MaxQuota:         1000000,
		DailyWinnerLimit: 1, // 全站每日只有 1 个永久名额
	})
	gameCfg := budgetsFor(10000000)

	first := drawTestUser(t, db)
	res1, err := drawSvc.DoDraw(cfg, gameCfg, first)
	if err != nil {
		t.Fatalf("第一次抽奖: %v", err)
	}
	if res1.Draw.QuotaType != QuotaTypePermanent || res1.Draw.Reason != DrawReasonOK {
		t.Fatalf("第一人应拿永久额度,实际 type=%s reason=%s", res1.Draw.QuotaType, res1.Draw.Reason)
	}

	newapiID := int64(44)
	second := &model.User{LinuxDOID: "second", LinuxDOName: "b", NewapiUserID: &newapiID, Status: 1}
	if err := db.Create(second).Error; err != nil {
		t.Fatalf("create second user: %v", err)
	}
	res2, err := drawSvc.DoDraw(cfg, gameCfg, second)
	if err != nil {
		t.Fatalf("第二次抽奖: %v", err)
	}
	if res2.Draw.QuotaType != QuotaTypeTemporary {
		t.Fatalf("名额满后应降级为限时额度,实际 %s", res2.Draw.QuotaType)
	}
	if res2.Draw.Reason != DrawReasonJackpotFalback {
		t.Fatalf("应记 jackpot_fallback,实际 %s", res2.Draw.Reason)
	}
	if res2.Draw.Quota != 1000000 {
		t.Fatalf("降级只改类型不改金额,实际 %d", res2.Draw.Quota)
	}
	// 流水里冻结的类型必须与降级后一致,否则自动重试会补发成永久额度。
	if res2.Grant == nil || res2.Grant.QuotaType != QuotaTypeTemporary {
		t.Fatalf("发放流水的额度类型应冻结为限时,实际 %+v", res2.Grant)
	}
}

// TestDoDrawNoPrizeMakesNoGrant 验证无额度档不产生任何发放流水。
func TestDoDrawNoPrizeMakesNoGrant(t *testing.T) {
	svc, mock, db := setupGrantService(t)
	defer mock.Close()
	drawSvc := NewDrawService(db, svc)
	user := drawTestUser(t, db)

	cfg := singleTierConfig(DrawTier{Label: "一般般绿", RewardType: QuotaTypeTemporary})
	res, err := drawSvc.DoDraw(cfg, budgetsFor(10000000), user)
	if err != nil {
		t.Fatalf("抽奖: %v", err)
	}
	if res.Draw.Reason != DrawReasonNoPrize || res.Draw.Quota != 0 {
		t.Fatalf("应是无奖档,实际 reason=%s quota=%d", res.Draw.Reason, res.Draw.Quota)
	}
	if res.Grant != nil {
		t.Fatal("无奖档不应产生发放流水")
	}
	var grants int64
	db.Model(&model.Grant{}).Where("type = ?", GrantTypeDraw).Count(&grants)
	if grants != 0 {
		t.Fatalf("不应有抽奖流水,实际 %d 条", grants)
	}
	// 无奖也不该动预算。
	var budgetRows int64
	db.Model(&model.DailyBudget{}).Where("scope = ?", BudgetScopeDraw).Count(&budgetRows)
	if budgetRows != 0 {
		t.Fatalf("无奖档不应建预算行,实际 %d 行", budgetRows)
	}
}

// TestDoDrawDisabledAndUnbound 验证关闭抽奖与未绑定账号的两道入口校验。
func TestDoDrawDisabledAndUnbound(t *testing.T) {
	svc, mock, db := setupGrantService(t)
	defer mock.Close()
	drawSvc := NewDrawService(db, svc)

	cfg := singleTierConfig(DrawTier{Label: "无奖", RewardType: QuotaTypeTemporary})
	cfg.Enabled = false
	user := drawTestUser(t, db)
	if _, err := drawSvc.DoDraw(cfg, budgetsFor(1000), user); !errors.Is(err, ErrDrawDisabled) {
		t.Fatalf("关闭时应返回 ErrDrawDisabled,实际 %v", err)
	}

	cfg.Enabled = true
	unbound := &model.User{LinuxDOID: "unbound", LinuxDOName: "u", Status: 1}
	if err := db.Create(unbound).Error; err != nil {
		t.Fatalf("create unbound user: %v", err)
	}
	if _, err := drawSvc.DoDraw(cfg, budgetsFor(1000), unbound); !errors.Is(err, ErrDrawNotBound) {
		t.Fatalf("未绑定应返回 ErrDrawNotBound,实际 %v", err)
	}
}

// TestDrawBudgetRulesFallsBackWhenScopeMissing 是存量升级的防线:
// 老 game_config 里没有 draw 键,若按「池不存在=放行」处理,抽奖就成了唯一
// 没有每日上限的发放入口。这里验证缺键时回落成启用的保底池。
func TestDrawBudgetRulesFallsBackWhenScopeMissing(t *testing.T) {
	legacy := &GameConfig{
		Timezone: "Asia/Shanghai",
		Budgets: map[string]BudgetRule{
			BudgetScopeGame: {Enabled: true, Daily: 10000000},
		},
	}
	rules := drawBudgetRules(legacy)
	got, ok := rules[BudgetScopeDraw]
	if !ok {
		t.Fatal("缺 draw 键时必须回落保底池,否则抽奖无每日上限")
	}
	if !got.Enabled || got.Daily <= 0 {
		t.Fatalf("保底池必须是启用且有上限的,实际 %+v", got)
	}

	// 站长显式关闭要被尊重,不能被保底值覆盖。
	off := &GameConfig{Budgets: map[string]BudgetRule{BudgetScopeDraw: {Enabled: false}}}
	if r := drawBudgetRules(off)[BudgetScopeDraw]; r.Enabled {
		t.Fatal("站长显式关闭 draw 池时不应被保底值覆盖")
	}
}

// TestGetDrawViewReflectsTodayDraw 验证视图接口在抽过/没抽过两态下的输出。
func TestGetDrawViewReflectsTodayDraw(t *testing.T) {
	svc, mock, db := setupGrantService(t)
	defer mock.Close()
	drawSvc := NewDrawService(db, svc)
	user := drawTestUser(t, db)

	cfg := singleTierConfig(DrawTier{Label: "一般般绿", Quip: "朴素", RewardType: QuotaTypeTemporary})
	now := time.Now()

	view, err := drawSvc.GetDrawView(cfg, user, now)
	if err != nil {
		t.Fatalf("视图: %v", err)
	}
	if view["drawn_today"] != false {
		t.Fatal("未抽奖时 drawn_today 应为 false")
	}
	if _, has := view["result"]; has {
		t.Fatal("未抽奖时不应有 result")
	}

	if _, err := drawSvc.DoDraw(cfg, budgetsFor(10000000), user); err != nil {
		t.Fatalf("抽奖: %v", err)
	}
	view, err = drawSvc.GetDrawView(cfg, user, now)
	if err != nil {
		t.Fatalf("视图: %v", err)
	}
	if view["drawn_today"] != true {
		t.Fatal("抽奖后 drawn_today 应为 true")
	}
	res, has := view["result"].(map[string]any)
	if !has {
		t.Fatalf("抽奖后应有 result,实际 %#v", view["result"])
	}
	if res["quip"] != "朴素" {
		t.Fatalf("result 应带上当前档位文案,实际 %v", res["quip"])
	}
	roll, _ := res["roll"].(int)
	if roll < 1 || roll > 100 {
		t.Fatalf("幸运数字应在 1-100,实际 %v", res["roll"])
	}
}

// TestRollLuckyRange 验证摇号只落在 1-100(含两端),不会出现 0。
// 0 会让「幸运指数」显示成 0 并落进任何档位表的空档。
func TestRollLuckyRange(t *testing.T) {
	seen := map[int]bool{}
	for i := 0; i < 5000; i++ {
		r := rollLucky()
		if r < 1 || r > 100 {
			t.Fatalf("rollLucky 越界: %d", r)
		}
		seen[r] = true
	}
	// 5000 次抽样下 1 和 100 都该出现过,确认区间是闭的。
	if !seen[1] || !seen[100] {
		t.Fatalf("5000 次抽样未覆盖边界值(1:%v 100:%v)", seen[1], seen[100])
	}
}

// TestPickQuotaWithinTierRange 验证金额落在档位区间内。
func TestPickQuotaWithinTierRange(t *testing.T) {
	tier := DrawTier{MinQuota: 1500000, MaxQuota: 4000000}
	for i := 0; i < 2000; i++ {
		q := pickQuota(tier)
		if q < tier.MinQuota || q > tier.MaxQuota {
			t.Fatalf("金额越界: %d 不在 [%d,%d]", q, tier.MinQuota, tier.MaxQuota)
		}
	}
	if got := pickQuota(DrawTier{MinQuota: 0, MaxQuota: 0}); got != 0 {
		t.Fatalf("无奖档金额应为 0,实际 %d", got)
	}
	if got := pickQuota(DrawTier{MinQuota: 500, MaxQuota: 500}); got != 500 {
		t.Fatalf("固定金额档应返回该值,实际 %d", got)
	}
}

// ---- 单次发放上限(grant_config)----

// TestGrantConfigSeedsFromEnv 验证首次运行用环境变量值播种:
// 存量部署升级后行为与升级前一致,不会因为搬进配置表而突然改变上限。
func TestGrantConfigSeedsFromEnv(t *testing.T) {
	db := grantDB(t)
	const envDefault = 7777777
	cfg, err := GetGrantConfig(db, envDefault)
	if err != nil {
		t.Fatalf("读取: %v", err)
	}
	if cfg.MaxGrantQuota != envDefault {
		t.Fatalf("首次应用环境变量播种 %d,实际 %d", envDefault, cfg.MaxGrantQuota)
	}
	// 落库后环境变量不再生效:传一个不同的值也应读回已保存的那份。
	again, err := GetGrantConfig(db, 111)
	if err != nil {
		t.Fatalf("再读: %v", err)
	}
	if again.MaxGrantQuota != envDefault {
		t.Fatalf("落库后应忽略环境变量,实际 %d", again.MaxGrantQuota)
	}
}

// TestSaveGrantConfigGuards 验证 0/负数被拒、以及「多打零」被绝对天花板挡住。
func TestSaveGrantConfigGuards(t *testing.T) {
	db := grantDB(t)
	for _, bad := range []int64{0, -1, grantConfigAbsoluteMax + 1} {
		if err := SaveGrantConfig(db, &GrantConfig{MaxGrantQuota: bad}); err == nil {
			t.Fatalf("上限 %d 应当被拒绝", bad)
		}
	}
	if err := SaveGrantConfig(db, &GrantConfig{MaxGrantQuota: 20000000}); err != nil {
		t.Fatalf("合法上限应可保存: %v", err)
	}
	if got := MaxGrantQuotaOf(db, 1); got != 20000000 {
		t.Fatalf("保存后应读回 20000000,实际 %d", got)
	}
}

// TestMaxGrantQuotaOfNeverReturnsZero 是关键防线:返回 0 会让「quota <= max」
// 这类校验把**一切发放**都拒掉,等于用一条坏配置静默关停整站发放。
func TestMaxGrantQuotaOfNeverReturnsZero(t *testing.T) {
	db := grantDB(t)
	// 手工写入一份坏配置(绕过 SaveGrantConfig 的校验,模拟人工改库或旧数据)。
	if err := SetSetting(db, GrantConfigKey, `{"max_grant_quota":0}`); err != nil {
		t.Fatalf("写入坏配置: %v", err)
	}
	if got := MaxGrantQuotaOf(db, 5000000); got != 5000000 {
		t.Fatalf("坏配置应回落环境变量 5000000,实际 %d", got)
	}
}
