import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import Header from '@/components/Header'
import Quota from '@/components/Quota'
import { Badge, Button, Card, Spinner } from '@/components/ui'
import { Clover } from '@/components/Clover'
import { api, Page, GrantRecord } from '@/lib/api'
import { formatDateTime } from '@/lib/format'

const typeMap: Record<string, string> = { checkin: '签到', activity: '活动', manual: '手动' }

/* 类型决定叶片配色:签到翠绿、活动鎏金、手动浅绿 */
const typePetal: Record<string, [string, string]> = {
  checkin: ['#35a465', '#5bbc82'],
  activity: ['#ddb45f', '#eed9a4'],
  manual: ['#8fd6a8', '#bce3c9'],
}

/* 每页条数(后端上限 100) */
const PAGE_SIZE = 20

export default function RecordsPage() {
  const [page, setPage] = useState(1)
  const { data, isLoading, isFetching } = useQuery({
    queryKey: ['my-grants', page],
    queryFn: () => api.get<Page<GrantRecord>>(`/api/user/grants?page=${page}&page_size=${PAGE_SIZE}`),
    /* 翻页时保留上一页数据,避免整页闪 Spinner */
    placeholderData: (prev) => prev,
  })

  const items = data?.items ?? []
  const total = data?.total ?? 0
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))

  return (
    <div className="relative min-h-screen">
      <Header />
      <main className="relative z-10 mx-auto max-w-3xl px-4 pb-16 pt-8">
        <section className="stagger pb-6 text-center">
          <h1 className="title-kai text-3xl leading-snug sm:text-4xl">
            我的<span className="word-gold px-1">摘叶</span>记录
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            签到、活动与手动补发的每一次到账,都记在这里
          </p>
        </section>

        {isLoading ? (
          <div className="flex justify-center py-20">
            <Spinner size={40} />
          </div>
        ) : items.length === 0 ? (
          <Card className="flex flex-col items-center px-6 py-12 text-center">
            <div className="relative h-24 w-32">
              <span className="absolute left-1/2 top-0 -translate-x-1/2 animate-sway">
                <Clover size={48} petal="#bce3c9" petalAlt="#dcf1e2" />
              </span>
              <span className="absolute bottom-1 left-2 animate-float-leaf">
                <Clover size={26} stem={false} petal="#dcf1e2" petalAlt="#f0f9f2" />
              </span>
              <span
                className="absolute bottom-4 right-2 animate-float-leaf"
                style={{ animationDelay: '1.4s' }}
              >
                <Clover size={20} stem={false} petal="#dcf1e2" petalAlt="#f0f9f2" />
              </span>
            </div>
            <p className="mt-4 font-kai text-xl text-clover-800">账本还是空的</p>
            <p className="mt-1 max-w-xs text-sm text-muted-foreground">
              去首页摘一片四叶草,第一笔到账就会长在这里。
            </p>
            <Link to="/" className="mt-5">
              <Button variant="outline" size="sm">去首页签到</Button>
            </Link>
          </Card>
        ) : (
          <>
            <Card
              className={`divide-y divide-clover-50 px-4 py-1 transition-opacity sm:px-5 ${
                isFetching ? 'opacity-60' : ''
              }`}
            >
              {items.map((g) => {
                const [petal, petalAlt] = typePetal[g.type] ?? typePetal.manual
                return (
                  <div key={g.id} className="flex items-center gap-3 py-3.5 sm:gap-4">
                    <span className="shrink-0">
                      <Clover size={24} stem={false} petal={petal} petalAlt={petalAlt} />
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="flex flex-wrap items-center gap-2">
                        <span className="font-medium text-clover-800">
                          {typeMap[g.type] ?? g.type}
                        </span>
                        <Badge className={statusCls(g.status)}>{statusText(g.status)}</Badge>
                      </p>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        {formatDateTime(g.created_at)}
                      </p>
                    </div>
                    <span className="word-gold shrink-0 font-kai text-lg">
                      <Quota value={g.quota} raw />
                    </span>
                  </div>
                )
              })}
            </Card>

            {total > 0 && (
              <div className="mt-5 flex items-center justify-center gap-2 sm:gap-3">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={page <= 1}
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                >
                  <ChevronLeft size={15} />
                  上一页
                </Button>
                <span className="text-sm text-clover-700/85">
                  第 {page} / {totalPages} 页
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={page >= totalPages}
                  onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                >
                  下一页
                  <ChevronRight size={15} />
                </Button>
              </div>
            )}
          </>
        )}
      </main>
    </div>
  )
}

function statusText(s: string) {
  return { success: '已到账', failed: '失败', pending: '处理中' }[s] ?? s
}

function statusCls(s: string) {
  return {
    success: 'border border-clover-200 bg-clover-50 text-clover-700',
    failed: 'border border-red-100 bg-red-50 text-red-500',
    pending: 'border border-gold-300 bg-cream text-gold-600',
  }[s] ?? 'border border-clover-100 bg-muted text-muted-foreground'
}
