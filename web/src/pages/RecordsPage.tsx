import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
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

export default function RecordsPage() {
  const { data, isLoading } = useQuery({
    queryKey: ['my-grants'],
    queryFn: () => api.get<Page<GrantRecord>>('/api/user/grants?page=1&page_size=50'),
  })

  const items = data?.items ?? []

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
          <Card className="divide-y divide-clover-50 px-4 py-1 sm:px-5">
            {items.map((g) => {
              const [petal, petalAlt] = typePetal[g.type] ?? typePetal.manual
              return (
                <div key={g.id} className="flex items-center gap-3 py-3.5 sm:gap-4">
                  <span className="shrink-0">
                    <Clover size={24} stem={false} petal={petal} petalAlt={petalAlt} />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="flex flex-wrap items-center gap-2">
                      <span className="font-medium text-clover-800">{typeMap[g.type] ?? g.type}</span>
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
