import { useEffect, useRef, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { ArrowRight, Check, CheckCircle2, ExternalLink, Link2, LogIn, RefreshCw, ShieldCheck } from 'lucide-react'
import { Clover } from '@/components/Clover'
import { Button, Spinner } from '@/components/ui'
import { ActionLink, QueryFeedback, SitePageHeading, SitePanel, SiteShell, siteActionClass } from '@/components/site'
import { api, ApiError, type SelfInfo } from '@/lib/api'
import { useMe, useSiteInfo } from '@/hooks/useMe'

interface BindingDetection {
  bound: boolean
  newapi_user_id: number | null
}

type DetectionFeedback = { kind: 'info' | 'error'; title: string; description: string }

export default function BindPage() {
  const self = useMe()

  return (
    <SiteShell contentClassName="max-w-4xl">
      <BindingContent key={self.data?.user.id ?? 'anonymous'} self={self} />
    </SiteShell>
  )
}

function BindingContent({ self }: { self: ReturnType<typeof useMe> }) {
  const site = useSiteInfo()
  const qc = useQueryClient()
  const detecting = useRef(false)
  const successHeading = useRef<HTMLHeadingElement>(null)
  const [feedback, setFeedback] = useState<DetectionFeedback | null>(null)
  const [confirmed, setConfirmed] = useState<BindingDetection | null>(null)
  const [authRejected, setAuthRejected] = useState(false)
  const expired = authRejected || (self.error instanceof ApiError && self.error.status === 401)
  const me = expired ? undefined : self.data
  const bound = !!me && (me.bound || !!confirmed?.bound)
  const newapiUrl = site.data?.newapi_url?.trim()

  const rebind = useMutation({
    mutationFn: (_userId: number) => api.post<BindingDetection>('/api/user/rebind'),
    onMutate: () => setFeedback(null),
    onSuccess: async (result, userId) => {
      if (qc.getQueryData<SelfInfo>(['me'])?.user.id !== userId) return

      if (result.bound) {
        // Detection confirms the connection even if the later self refresh fails.
        // Cancel older self requests before sharing that confirmed prerequisite.
        setConfirmed(result)
        await qc.cancelQueries({ queryKey: ['me'] })
        const selfError = qc.getQueryState(['me'])?.error
        if (selfError instanceof ApiError && selfError.status === 401) return
        qc.setQueryData<SelfInfo>(['me'], (current) => {
          if (!current || current.user.id !== userId) return current
          return {
            ...current,
            bound: true,
            user: {
              ...current.user,
              newapi_user_id: result.newapi_user_id ?? current.user.newapi_user_id,
            },
          }
        })
      } else {
        setFeedback({
          kind: 'info',
          title: '暂未检测到可绑定账号',
          description: '请确认在 new-api 使用同一个 LinuxDO 账号登录。账号查询也可能暂时不可用，你可以稍后重新检测。',
        })
      }

      // Refresh failures belong to their queries, not to the confirmed bind.
      void Promise.allSettled([
        qc.invalidateQueries({ queryKey: ['me'] }),
        qc.invalidateQueries({ queryKey: ['checkin'] }),
      ])
    },
    onError: (error: Error, userId) => {
      if (qc.getQueryData<SelfInfo>(['me'])?.user.id !== userId) return
      if (error instanceof ApiError && error.status === 401) {
        setAuthRejected(true)
        void qc.invalidateQueries({ queryKey: ['me'] })
        return
      }
      setFeedback({ kind: 'error', title: '这次检测没有完成', description: error.message || '请求失败，请稍后再试。' })
    },
    onSettled: () => { detecting.current = false },
  })

  useEffect(() => {
    if (confirmed?.bound) successHeading.current?.focus({ preventScroll: true })
  }, [confirmed])

  function detectAccount() {
    if (detecting.current || rebind.isPending || !me || bound || self.isFetching || self.isError) return
    detecting.current = true
    setFeedback(null)
    rebind.mutate(me.user.id)
  }

  const accountId = confirmed?.newapi_user_id ?? me?.user.newapi_user_id
  const accountName = me?.user.newapi_username || (accountId != null ? 'new-api #' + accountId : 'new-api 账号')

  return (
    <div className="site-motion stagger">
      <SitePageHeading
        eyebrow="账号连接 · 让好运有归处"
        title={<span className="flex items-center gap-3"><Clover size={35} stem={false} />{bound ? '账号已连接' : '连接你的账号'}</span>}
        description={bound ? '福利奖励有了去处，回到小站继续收获今天的好运。' : '通过当前 LinuxDO 身份，找到对应的 new-api 账号，让福利奖励送进你的钱包。'}
      />

      {self.isPending && !me ? (
        <QueryFeedback kind="loading" title="正在读取登录状态" description="确认当前账号后，就可以继续连接。" />
      ) : expired || (!me && !self.isError) ? (
        <QueryFeedback
          kind="info"
          title={expired ? '请先登录 LinuxDO' : '登录后连接你的账号'}
          description="连接时会使用你当前的 LinuxDO 身份。请在福利站与 new-api 使用同一个账号登录。"
          action={<ActionLink href="/api/oauth/linuxdo"><LogIn size={17} aria-hidden="true" />LinuxDO 登录</ActionLink>}
        />
      ) : self.isError && !confirmed ? (
        <QueryFeedback
          kind="error"
          title="账号信息暂时无法加载"
          description={<><p>{self.error.message}</p><p>重新加载账号信息后，再继续连接。</p></>}
          onRetry={() => void self.refetch({ cancelRefetch: false })}
          retrying={self.isFetching}
        />
      ) : me && bound ? (
        <SitePanel className="overflow-hidden">
          <div className="grid md:grid-cols-[1.2fr_1fr]">
            <section className="p-5 sm:p-7">
              <span className="mb-5 inline-flex items-center gap-2 rounded-full border border-clover-200 bg-clover-50 px-3 py-1.5 text-sm font-medium text-clover-800">
                <CheckCircle2 size={16} aria-hidden="true" />连接已确认
              </span>
              <h2 ref={successHeading} tabIndex={-1} className="break-words text-xl font-semibold text-clover-900 outline-none">你的奖励，已经认得路了</h2>
              <dl className="mt-6 space-y-4 text-sm">
                <div><dt className="text-clover-700">LinuxDO 账号</dt><dd className="mt-1 break-all font-semibold text-clover-900">{me.user.display_name || me.user.linux_do_name}</dd><dd className="mt-1 break-all text-xs text-clover-700">@{me.user.linux_do_name} · ID {me.user.linux_do_id}</dd></div>
                <div><dt className="text-clover-700">已连接的 new-api 账号</dt><dd className="mt-1 break-all font-semibold text-clover-900">{accountName}</dd>{me.user.newapi_username && accountId != null && <dd className="mt-1 text-xs text-clover-700">ID {accountId}</dd>}</div>
              </dl>
              {confirmed && self.isFetching && <QueryFeedback className="mt-5" compact kind="loading" title="绑定已确认，正在同步账号信息" description="钱包与账号资料正在刷新。" />}
              {confirmed && self.isError && <QueryFeedback className="mt-5" compact kind="error" title="绑定已确认，账号信息刷新未完成" description={<><p>{self.error.message}</p><p>绑定结果已保留，可以重新加载账号资料。</p></>} onRetry={() => void self.refetch({ cancelRefetch: false })} retrying={self.isFetching} />}
              {confirmed && !self.isFetching && !self.isError && !me.bound && <QueryFeedback className="mt-5" compact kind="info" title="绑定已确认，账号信息仍在同步" onRetry={() => void self.refetch({ cancelRefetch: false })} retrying={self.isFetching} />}
              <div className="mt-7 flex flex-col gap-3 sm:flex-row sm:flex-wrap">
                <ActionLink to="/" className="w-full sm:w-auto">回首页查看今日福利<ArrowRight size={17} aria-hidden="true" /></ActionLink>
                <ActionLink to="/records" variant="outline" className="w-full sm:w-auto">查看我的记录</ActionLink>
              </div>
            </section>
            <aside className="border-t border-clover-100 bg-clover-50/60 p-5 sm:p-7 md:border-l md:border-t-0">
              <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-2xl border border-clover-200 bg-white/90"><Clover size={30} stem={false} /></div>
              <h2 className="font-semibold text-clover-900">下一片好运，在小站等你</h2>
              <p className="mt-3 text-sm leading-7 text-clover-700">回首页查看今日签到、幸运翻牌和福利活动。每笔奖励的额度与到账状态，都可以在「我的记录」里找到。</p>
              <p className="mt-5 flex items-start gap-2 text-sm leading-6 text-clover-700"><ShieldCheck size={17} className="mt-0.5 shrink-0" aria-hidden="true" />已连接的账号会自动用于奖励发放。</p>
            </aside>
          </div>
        </SitePanel>
      ) : me ? (
        <SitePanel className="overflow-hidden">
          <div className="grid md:grid-cols-[1fr_1.2fr]">
            <section className="p-5 sm:p-7">
              <div className="flex items-center gap-2 text-sm font-medium text-clover-700"><Link2 size={17} aria-hidden="true" />当前 LinuxDO 账号</div>
              <h2 className="mt-4 break-all text-xl font-semibold text-clover-900">{me.user.display_name || me.user.linux_do_name}</h2>
              <p className="mt-2 break-all text-sm text-clover-700">@{me.user.linux_do_name}</p>
              <p className="mt-1 break-all text-xs text-clover-700">LinuxDO ID {me.user.linux_do_id}</p>
              <span className="mt-5 inline-flex items-center gap-1.5 rounded-full border border-gold-300 bg-cream px-3 py-1.5 text-xs font-medium text-clover-800">尚未连接 new-api</span>
              <p className="mt-5 text-sm leading-7 text-clover-700">在 new-api 使用这个 LinuxDO 账号登录，再回来检测。连接成功后，签到和活动奖励就有了对应的钱包。</p>
              <p className="mt-5 flex items-start gap-2 text-xs leading-6 text-clover-700"><ShieldCheck size={16} className="mt-1 shrink-0" aria-hidden="true" />通过同一账号自动匹配，无需填写账号密码。</p>
            </section>

            <section aria-labelledby="bind-guide-title" className="border-t border-clover-100 bg-clover-50/60 p-5 sm:p-7 md:border-l md:border-t-0">
              <h2 id="bind-guide-title" className="font-semibold text-clover-900">两步，让好运就位</h2>
              <ol className="mt-5 space-y-6">
                <li className="flex gap-3">
                  <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-clover-100 text-sm font-semibold text-clover-800" aria-hidden="true">1</span>
                  <div className="min-w-0 flex-1">
                    <h3 className="font-medium leading-7 text-clover-900">在 new-api 使用 LinuxDO 登录</h3>
                    <p className="mt-1 text-sm leading-6 text-clover-700">首次使用时，按站点提示完成注册。</p>
                    {newapiUrl && <ActionLink href={newapiUrl} target="_blank" rel="noopener noreferrer" variant="outline" className="mt-3 w-full px-3 sm:w-auto">打开 new-api<ExternalLink size={15} aria-hidden="true" /><span className="sr-only">（新窗口）</span></ActionLink>}
                    {site.isPending ? <QueryFeedback className="mt-3" compact kind="loading" title="正在加载站点入口" />
                      : site.isError ? <QueryFeedback className="mt-3" compact kind="error" title="站点入口暂时无法更新" description={newapiUrl ? '当前入口来自上次加载的信息。' : '重新加载后，可以查看站点提供的入口。'} onRetry={() => void site.refetch({ cancelRefetch: false })} retrying={site.isFetching} />
                        : !newapiUrl && <QueryFeedback className="mt-3" compact kind="info" title="站点暂未提供公开入口" description="请使用站长提供的 new-api 地址登录，完成后回到这里检测。" />}
                  </div>
                </li>
                <li className="flex gap-3">
                  <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-clover-100 text-sm font-semibold text-clover-800" aria-hidden="true">2</span>
                  <div className="min-w-0 flex-1">
                    <h3 className="font-medium leading-7 text-clover-900">回到这里，检测连接</h3>
                    <p className="mt-1 text-sm leading-6 text-clover-700">已完成登录？现在就可以检测。</p>
                    <Button type="button" className={siteActionClass({ className: 'mt-3 h-auto min-h-12 w-full px-3' })} disabled={rebind.isPending || self.isFetching} onClick={detectAccount}>
                      {rebind.isPending || self.isFetching ? <Spinner size={18} /> : <RefreshCw size={17} aria-hidden="true" />}
                      {rebind.isPending ? '正在检测账号…' : self.isFetching ? '正在同步账号…' : '我已登录，重新检测'}
                    </Button>
                  </div>
                </li>
              </ol>
              <div aria-live="polite" aria-atomic="true" className="mt-4">
                {rebind.isPending ? <QueryFeedback compact kind="loading" title="正在查找对应的 new-api 账号" description="请稍等，检测结果会显示在这里。" /> : feedback && <QueryFeedback compact {...feedback} />}
              </div>
            </section>
          </div>
        </SitePanel>
      ) : null}

      <div className="mt-6 flex flex-wrap items-center justify-between gap-3 text-sm text-clover-700">
        <span className="flex items-center gap-1.5"><Check size={15} aria-hidden="true" />同一个 LinuxDO 账号，一份自己的好运</span>
        <ActionLink to="/" variant="ghost" className="px-3">返回小站<ArrowRight size={15} aria-hidden="true" /></ActionLink>
      </div>
    </div>
  )
}
