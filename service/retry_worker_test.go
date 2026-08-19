package service

import (
	"context"
	"sync/atomic"
	"testing"
	"time"

	"welfare/model"

	"gorm.io/gorm"
)

// setupRetryWorker 造一个时钟可控的 worker(测试里手动推进时间,不真等退避)。
func setupRetryWorker(t *testing.T, maxAttempts int) (*RetryWorker, *GrantService, *mockNewAPI, *gorm.DB, *time.Time) {
	t.Helper()
	svc, mock, db := setupGrantService(t)
	t.Cleanup(mock.Close)
	clock := time.Date(2026, 8, 19, 10, 0, 0, 0, time.UTC)
	w := NewRetryWorker(db, svc, time.Minute, maxAttempts)
	w.now = func() time.Time { return clock }
	return w, svc, mock, db, &clock
}

// newFailedGrant 造一条已经外呼失败的流水(mock 需先设好 failNext)。
func newFailedGrant(t *testing.T, svc *GrantService, refID int64) *model.Grant {
	t.Helper()
	gr := &model.Grant{UserID: 1, NewapiUserID: 42, Type: "checkin", RefID: refID, Quota: 100}
	if err := svc.Grant(gr); err == nil {
		t.Fatalf("首次发放应当失败(mock.failNext 没设对?)")
	}
	if gr.Status != GrantStatusFailed {
		t.Fatalf("流水应为 failed,实际 %s", gr.Status)
	}
	return gr
}

func loadGrant(t *testing.T, db *gorm.DB, id int64) model.Grant {
	t.Helper()
	var g model.Grant
	if err := db.First(&g, id).Error; err != nil {
		t.Fatalf("读取流水 %d: %v", id, err)
	}
	return g
}

// TestRetryWorkerBackoffProgression 验证连续失败时重试计数与退避时间按
// 1/5/15/60/360 分钟推进。
func TestRetryWorkerBackoffProgression(t *testing.T) {
	w, svc, mock, db, clock := setupRetryWorker(t, 5)
	mock.failNext = 1000 // 所有外呼都失败
	gr := newFailedGrant(t, svc, 101)

	wantDelays := []time.Duration{time.Minute, 5 * time.Minute, 15 * time.Minute, time.Hour, 6 * time.Hour}
	for i, delay := range wantDelays {
		st := w.RunOnce(context.Background())
		if st.Processed != 1 || st.Failed != 1 || st.Succeeded != 0 {
			t.Fatalf("第 %d 轮统计异常: %+v", i+1, st)
		}
		g := loadGrant(t, db, gr.ID)
		if g.Status != GrantStatusFailed {
			t.Fatalf("第 %d 轮后应仍为 failed,实际 %s", i+1, g.Status)
		}
		if g.RetryCount != i+1 {
			t.Fatalf("第 %d 轮后 retry_count = %d, want %d", i+1, g.RetryCount, i+1)
		}
		if g.NextRetryAt == nil {
			t.Fatalf("第 %d 轮后 next_retry_at 不应为空", i+1)
		}
		want := clock.Add(delay)
		if diff := g.NextRetryAt.Sub(want); diff > time.Second || diff < -time.Second {
			t.Fatalf("第 %d 轮后 next_retry_at = %s, want %s", i+1, g.NextRetryAt, want)
		}
		// 最后一轮达到上限,统计里要提示需人工处理。
		if i == len(wantDelays)-1 && st.Exhausted != 1 {
			t.Fatalf("末轮应标记 1 条已用尽重试预算,实际 %+v", st)
		}
		*clock = clock.Add(delay) // 推进到刚好到期
	}
}

// TestRetryWorkerStopsAtMaxAttempts 验证达到上限后不再被自动重试选中。
func TestRetryWorkerStopsAtMaxAttempts(t *testing.T) {
	w, svc, mock, db, clock := setupRetryWorker(t, 3)
	mock.failNext = 1000
	gr := newFailedGrant(t, svc, 102)

	for i := 0; i < 3; i++ {
		if st := w.RunOnce(context.Background()); st.Processed != 1 {
			t.Fatalf("第 %d 轮应处理 1 条,实际 %+v", i+1, st)
		}
		*clock = clock.Add(24 * time.Hour) // 远超退避,排除时间因素
	}
	callsBefore := atomic.LoadInt64(&mock.callCount)

	if st := w.RunOnce(context.Background()); st.Processed != 0 {
		t.Fatalf("达上限后不应再处理,实际 %+v", st)
	}
	if got := atomic.LoadInt64(&mock.callCount); got != callsBefore {
		t.Fatalf("达上限后不应再外呼 new-api: %d → %d", callsBefore, got)
	}
	if g := loadGrant(t, db, gr.ID); g.RetryCount != 3 {
		t.Fatalf("retry_count 应停在 3,实际 %d", g.RetryCount)
	}
}

// TestRetryWorkerSkipsNotDueGrant 验证退避未到期的流水不被选中。
func TestRetryWorkerSkipsNotDueGrant(t *testing.T) {
	w, svc, mock, _, clock := setupRetryWorker(t, 5)
	mock.failNext = 1000
	newFailedGrant(t, svc, 103)

	if st := w.RunOnce(context.Background()); st.Processed != 1 {
		t.Fatalf("首轮应处理 1 条,实际 %+v", st)
	}
	callsBefore := atomic.LoadInt64(&mock.callCount)

	// 退避 1 分钟,此刻与 59 秒后都不该被捞出来。
	if st := w.RunOnce(context.Background()); st.Processed != 0 {
		t.Fatalf("退避未到期不应处理,实际 %+v", st)
	}
	*clock = clock.Add(59 * time.Second)
	if st := w.RunOnce(context.Background()); st.Processed != 0 {
		t.Fatalf("退避差 1 秒到期不应处理,实际 %+v", st)
	}
	if got := atomic.LoadInt64(&mock.callCount); got != callsBefore {
		t.Fatalf("未到期期间不应外呼 new-api: %d → %d", callsBefore, got)
	}

	// 到期后恢复处理。
	*clock = clock.Add(2 * time.Second)
	if st := w.RunOnce(context.Background()); st.Processed != 1 {
		t.Fatalf("到期后应处理 1 条,实际 %+v", st)
	}
}

// TestRetryWorkerSuccessGrantsOnce 验证补发成功后流水置 success,
// 且不会产生第二次发放(new-api 只被重试调用一次)。
func TestRetryWorkerSuccessGrantsOnce(t *testing.T) {
	w, svc, mock, db, _ := setupRetryWorker(t, 5)
	mock.failNext = 1 // 只有首次发放失败,之后 new-api 恢复
	gr := newFailedGrant(t, svc, 104)

	st := w.RunOnce(context.Background())
	if st.Processed != 1 || st.Succeeded != 1 {
		t.Fatalf("应成功补发 1 条,实际 %+v", st)
	}
	if g := loadGrant(t, db, gr.ID); g.Status != GrantStatusSuccess {
		t.Fatalf("补发后应为 success,实际 %s", g.Status)
	}
	if got := atomic.LoadInt64(&mock.successCalls); got != 1 {
		t.Fatalf("成功发放只应发生 1 次,实际 %d", got)
	}

	// 再扫若干轮都不该重复发放。
	callsBefore := atomic.LoadInt64(&mock.callCount)
	for i := 0; i < 3; i++ {
		if st := w.RunOnce(context.Background()); st.Processed != 0 {
			t.Fatalf("success 流水不应再被处理,实际 %+v", st)
		}
	}
	if got := atomic.LoadInt64(&mock.callCount); got != callsBefore {
		t.Fatalf("success 流水不应再外呼: %d → %d", callsBefore, got)
	}
}

// TestRetryWorkerSkipsPending 验证 worker 绝不碰 pending 流水:
// Retry 会先把状态改成 pending 再外呼,进程若在中间被杀,这条流水到底有没有到账
// 无法判断(new-api 发放接口非幂等),只能人工核对,自动重发会导致重复到账。
func TestRetryWorkerSkipsPending(t *testing.T) {
	w, _, mock, db, _ := setupRetryWorker(t, 5)

	stale := time.Now().Add(-2 * time.Hour)
	pending := model.Grant{UserID: 1, NewapiUserID: 42, Type: "manual", RefID: NewManualRefID(),
		Quota: 100, QuotaType: QuotaTypePermanent, Status: GrantStatusPending, UpdatedAt: stale}
	if err := db.Create(&pending).Error; err != nil {
		t.Fatalf("create pending: %v", err)
	}

	if st := w.RunOnce(context.Background()); st.Processed != 0 {
		t.Fatalf("pending 流水不应被自动重试,实际 %+v", st)
	}
	if got := atomic.LoadInt64(&mock.callCount); got != 0 {
		t.Fatalf("pending 流水不应触发任何外呼,实际 %d 次", got)
	}
	g := loadGrant(t, db, pending.ID)
	if g.Status != GrantStatusPending || g.RetryCount != 0 {
		t.Fatalf("pending 流水应原样不动,实际 status=%s retry_count=%d", g.Status, g.RetryCount)
	}
}

// TestRetryWorkerStopsOnContextCancel 验证 worker 靠 context 取消退出——
// main.go 的优雅退出依赖这一点(先停重试,再关 HTTP 服务)。
func TestRetryWorkerStopsOnContextCancel(t *testing.T) {
	w, _, _, _, _ := setupRetryWorker(t, 5)
	w.interval = 10 * time.Millisecond

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		w.Run(ctx)
		close(done)
	}()

	time.Sleep(30 * time.Millisecond)
	cancel()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("ctx 取消后 worker 应及时退出")
	}
}

// TestRetryWorkerRespectsCancelledContext 验证已取消的 ctx 不会再发起补发,
// 避免退出过程中还往 new-api 打请求。
func TestRetryWorkerRespectsCancelledContext(t *testing.T) {
	w, svc, mock, _, _ := setupRetryWorker(t, 5)
	mock.failNext = 1000
	newFailedGrant(t, svc, 106)
	callsBefore := atomic.LoadInt64(&mock.callCount)

	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if st := w.RunOnce(ctx); st.Processed != 0 {
		t.Fatalf("ctx 已取消不应处理任何流水,实际 %+v", st)
	}
	if got := atomic.LoadInt64(&mock.callCount); got != callsBefore {
		t.Fatalf("ctx 已取消不应外呼 new-api: %d → %d", callsBefore, got)
	}
}

// TestManualRetryResetsCounter 验证后台人工重试会把自动重试预算清零,
// 让流水重新获得完整的重试机会(哪怕人工这次也没发成功)。
func TestManualRetryResetsCounter(t *testing.T) {
	w, svc, mock, db, clock := setupRetryWorker(t, 5)
	mock.failNext = 1000
	gr := newFailedGrant(t, svc, 105)

	// 先自动重试两轮,攒出计数与退避时间。
	w.RunOnce(context.Background())
	*clock = clock.Add(time.Minute)
	w.RunOnce(context.Background())
	if g := loadGrant(t, db, gr.ID); g.RetryCount != 2 || g.NextRetryAt == nil {
		t.Fatalf("自动重试两轮后应为 retry_count=2 且有退避时间,实际 %d / %v", g.RetryCount, g.NextRetryAt)
	}

	// 人工重试(仍然失败):计数归零、退避清空。
	if err := svc.RetryManual(gr.ID); err == nil {
		t.Fatalf("new-api 仍不可用,人工重试应返回错误")
	}
	g := loadGrant(t, db, gr.ID)
	if g.Status != GrantStatusFailed {
		t.Fatalf("人工重试失败后应回到 failed,实际 %s", g.Status)
	}
	if g.RetryCount != 0 || g.NextRetryAt != nil {
		t.Fatalf("人工重试后应重置计数,实际 retry_count=%d next_retry_at=%v", g.RetryCount, g.NextRetryAt)
	}

	// 重置后立刻能被自动重试重新捞起。
	if st := w.RunOnce(context.Background()); st.Processed != 1 {
		t.Fatalf("重置后应重新进入自动重试队列,实际 %+v", st)
	}
}
