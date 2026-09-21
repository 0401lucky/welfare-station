import { useEffect } from 'react'
import { Home } from 'lucide-react'
import { ActionLink, QueryFeedback, SiteShell } from '@/components/site'
import { useSiteInfo } from '@/hooks/useMe'

/** 未匹配路由的兜底页:沿用站点外壳,只给一个明确的回家入口。 */
export default function NotFoundPage() {
  const { data: site } = useSiteInfo()

  useEffect(() => {
    const previous = document.title
    document.title = `页面不存在 · ${site?.site_name || '福利站'}`
    return () => { document.title = previous }
  }, [site?.site_name])

  return (
    <SiteShell contentClassName="max-w-3xl">
      <QueryFeedback
        kind="info"
        title="页面不存在"
        description="你访问的地址可能已失效，或者输入有误。"
        action={
          <ActionLink to="/" className="min-h-11">
            <Home size={15} aria-hidden="true" />
            返回首页
          </ActionLink>
        }
      />
    </SiteShell>
  )
}
