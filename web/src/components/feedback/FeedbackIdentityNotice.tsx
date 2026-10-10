import { ActionLink, QueryFeedback } from '@/components/site'
import type { FeedbackIdentity } from './useFeedbackIdentity'

export function FeedbackIdentityNotice({ identity, purpose = '登录后即可留言、发图片和参与讨论，也能查看自己的留言与回复。' }: {
  identity: FeedbackIdentity
  purpose?: string
}) {
  if (identity.self.isPending || identity.self.isFetching) return <QueryFeedback kind="loading" title="正在确认登录状态…" />
  if (identity.guest) return <QueryFeedback kind="info" title="用 LinuxDO 登录，留下一句话" description={purpose} action={<ActionLink href="/api/oauth/linuxdo">LinuxDO 登录</ActionLink>} />
  return <QueryFeedback kind="error" title="暂时无法确认登录状态" description="请重新加载账号信息后继续。" onRetry={() => void identity.self.refetch()} retrying={identity.self.isFetching} />
}
