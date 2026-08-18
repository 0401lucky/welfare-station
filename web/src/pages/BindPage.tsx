import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { ArrowRight, ExternalLink, RefreshCw, Terminal } from 'lucide-react'
import Header from '@/components/Header'
import { Button, Card, Spinner } from '@/components/ui'
import { Clover, CloverEmblem } from '@/components/Clover'
import { api } from '@/lib/api'
import { useMe } from '@/hooks/useMe'

const steps = [
  { icon: Terminal, title: '访问 new-api', desc: '打开站长提供的 new-api 站点' },
  { icon: ExternalLink, title: 'LinuxDO 登录', desc: '使用同一个 LinuxDO 账号登录并注册' },
  { icon: RefreshCw, title: '回来重新检测', desc: '回到本页点「重新检测」完成绑定' },
]

export default function BindPage() {
  const { data: me } = useMe()
  const qc = useQueryClient()
  const nav = useNavigate()
  const [msg, setMsg] = useState<string | null>(null)

  const rebind = useMutation({
    mutationFn: () => api.post<{ bound: boolean }>('/api/user/rebind'),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ['me'] })
      qc.invalidateQueries({ queryKey: ['checkin'] })
      if (r.bound) nav('/')
      else setMsg('仍未匹配到 new-api 账号,请确认已用 LinuxDO 在 new-api 注册')
    },
    onError: (e: Error) => setMsg(e.message),
  })

  return (
    <div className="relative min-h-screen">
      <Header />
      <main className="relative z-10 mx-auto max-w-2xl px-4 pb-16 pt-8">
        <section className="stagger flex flex-col items-center text-center">
          <CloverEmblem size={104} />
          <h1 className="title-kai mt-5 text-3xl leading-snug sm:text-4xl">
            还差一步,<span className="word-gold px-1">好运</span>就位
          </h1>
          <p className="mt-3 max-w-md text-[15px] leading-7 text-clover-700/80">
            绑定 new-api 账号之后,签到与活动摘到的叶子才知道该送进哪个钱包。
          </p>
          {me && (
            <span className="mt-4 flex max-w-full items-center gap-2 rounded-full border border-clover-100 bg-white/80 px-4 py-1.5 text-sm text-clover-700 shadow-leaf-sm">
              <span className="shrink-0">
                <Clover size={15} stem={false} />
              </span>
              <span className="min-w-0 truncate">
                当前登录 {me.user.display_name || me.user.linux_do_name}
              </span>
              <span className="hidden shrink-0 text-clover-700/60 sm:inline">
                · LinuxDO id {me.user.linux_do_id}
              </span>
            </span>
          )}
        </section>

        <div className="stagger mt-8 space-y-3">
          {steps.map((s, i) => (
            <Card key={i} className="flex items-center gap-4 p-4 sm:p-5">
              <span className="relative flex h-11 w-11 shrink-0 items-center justify-center">
                <Clover size={44} stem={false} petal="#dcf1e2" petalAlt="#f0f9f2" />
                <span className="absolute font-kai text-lg text-clover-700">{i + 1}</span>
              </span>
              <div className="min-w-0">
                <p className="flex items-center gap-1.5 font-bold text-clover-800">
                  <s.icon size={14} className="shrink-0 text-clover-500" />
                  {s.title}
                </p>
                <p className="mt-0.5 text-sm text-muted-foreground">{s.desc}</p>
              </div>
            </Card>
          ))}
        </div>

        {me?.bound ? (
          <Card className="mt-6 border-gold-300 bg-cream/85 p-6 text-center">
            <span className="inline-block animate-sway">
              <Clover size={40} petal="#ddb45f" petalAlt="#eed9a4" />
            </span>
            <p className="mt-2 font-bold text-clover-800">
              已绑定 new-api:{me.user.newapi_username}
            </p>
            <p className="mt-1 text-sm text-clover-700/75">叶子已经认得路了,回首页签到吧。</p>
          </Card>
        ) : (
          <Button
            variant="gradient"
            size="lg"
            className="mt-6 w-full"
            disabled={rebind.isPending}
            onClick={() => rebind.mutate()}
          >
            {rebind.isPending ? <Spinner size={20} /> : <RefreshCw size={18} />}
            重新检测
          </Button>
        )}

        {msg && (
          <p className="mt-4 rounded-2xl border border-red-100 bg-red-50/80 px-4 py-2.5 text-center text-sm text-red-500">
            {msg}
          </p>
        )}

        <p className="mt-6 flex items-center justify-center gap-1 text-center text-sm text-muted-foreground">
          已经绑定?
          <a href="/" className="inline-flex items-center gap-1 text-clover-600 hover:text-clover-800">
            回到首页 <ArrowRight size={14} />
          </a>
        </p>
      </main>
    </div>
  )
}
