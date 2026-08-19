package service

import (
	"context"
	"errors"
	"log"
	"time"

	"welfare/model"

	"gorm.io/gorm"
)

// retryBackoff 是自动重试的退避表:第 N 次自动重试失败后,等 retryBackoff[N-1] 再试。
// 1 分钟 → 5 分钟 → 15 分钟 → 1 小时 → 6 小时;次数超出表长时沿用最后一档。
var retryBackoff = []time.Duration{
	1 * time.Minute,
	5 * time.Minute,
	15 * time.Minute,
	1 * time.Hour,
	6 * time.Hour,
}

// retryBatchSize 是单轮最多处理的流水条数。new-api 长时间不可达时失败流水会堆积,
// 限量扫描避免一轮打爆对端(也让每轮耗时可预期,便于优雅退出)。
const retryBatchSize = 50

// RetryWorker 周期性地把 failed 流水补发掉,替代站长在后台逐条点「重试」。
//
// 只处理 failed,绝不碰 pending:Retry 会先把状态置 pending 再外呼 new-api,
// 若进程恰在两者之间被杀,这条流水会永久停在 pending——而此时无法判断 new-api
// 那笔到底执行了没有(add_quota / temporary_quota 都不是幂等接口,重发会重复到账)。
// 这类流水交由站长在后台核对后人工决定,后台列表会把它标成待人工确认。
type RetryWorker struct {
	db          *gorm.DB
	grants      *GrantService
	interval    time.Duration
	maxAttempts int
	now         func() time.Time // 测试注入时钟
}

func NewRetryWorker(db *gorm.DB, grants *GrantService, interval time.Duration, maxAttempts int) *RetryWorker {
	if interval <= 0 {
		interval = time.Minute
	}
	if maxAttempts < 0 {
		maxAttempts = 0
	}
	return &RetryWorker{db: db, grants: grants, interval: interval, maxAttempts: maxAttempts, now: time.Now}
}

// Run 阻塞运行直到 ctx 取消(优雅退出:当前这一轮跑完就返回)。
func (w *RetryWorker) Run(ctx context.Context) {
	log.Printf("失败发放自动重试已启动: 每 %s 扫一轮, 单条最多 %d 次", w.interval, w.maxAttempts)
	ticker := time.NewTicker(w.interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			log.Println("失败发放自动重试已停止")
			return
		case <-ticker.C:
			w.RunOnce(ctx)
		}
	}
}

// RetryStats 是单轮的处理统计,只用于日志与测试断言。
type RetryStats struct {
	Processed int // 实际执行了重试的条数(不含被人工抢走的)
	Succeeded int
	Failed    int
	Exhausted int // 本轮失败后达到上限、后续只能人工处理的条数
}

// RunOnce 扫一轮并重试选中的流水。ctx 取消时立即收手,已处理的结果都已落库。
func (w *RetryWorker) RunOnce(ctx context.Context) RetryStats {
	var stats RetryStats
	pending, err := w.pick()
	if err != nil {
		log.Printf("自动重试: 读取待重试流水失败: %v", err)
		return stats
	}
	for _, g := range pending {
		if ctx.Err() != nil {
			break
		}
		err := w.grants.Retry(g.ID)
		switch {
		case err == nil:
			stats.Processed++
			stats.Succeeded++
		case errors.Is(err, ErrNotFailed):
			// 已被人工重试抢走或状态已变,静默跳过,不消耗重试预算。
		default:
			stats.Processed++
			stats.Failed++
			if w.markFailure(&g) {
				stats.Exhausted++
			}
		}
	}
	if stats.Processed > 0 {
		if stats.Exhausted > 0 {
			log.Printf("自动重试: 处理 %d 条, 成功 %d, 仍失败 %d, 其中 %d 条已达重试上限需人工处理",
				stats.Processed, stats.Succeeded, stats.Failed, stats.Exhausted)
		} else {
			log.Printf("自动重试: 处理 %d 条, 成功 %d, 仍失败 %d", stats.Processed, stats.Succeeded, stats.Failed)
		}
	}
	return stats
}

// pick 选出本轮候选:失败、重试预算未用尽、且已过退避时间的流水,按 id 升序(先进先补)。
func (w *RetryWorker) pick() ([]model.Grant, error) {
	if w.maxAttempts <= 0 {
		return nil, nil
	}
	var grants []model.Grant
	err := w.db.Where(
		"status = ? AND retry_count < ? AND (next_retry_at IS NULL OR next_retry_at <= ?)",
		GrantStatusFailed, w.maxAttempts, w.now(),
	).Order("id asc").Limit(retryBatchSize).Find(&grants).Error
	return grants, err
}

// markFailure 记一次自动重试失败并按退避表推迟下次;返回该流水是否已用尽重试预算。
func (w *RetryWorker) markFailure(g *model.Grant) bool {
	count := g.RetryCount + 1
	idx := count - 1
	if idx >= len(retryBackoff) {
		idx = len(retryBackoff) - 1
	}
	next := w.now().Add(retryBackoff[idx])
	if err := w.db.Model(&model.Grant{}).Where("id = ?", g.ID).
		Updates(map[string]any{"retry_count": count, "next_retry_at": &next}).Error; err != nil {
		log.Printf("自动重试: 更新流水 %d 的重试计数失败: %v", g.ID, err)
	}
	return count >= w.maxAttempts
}
