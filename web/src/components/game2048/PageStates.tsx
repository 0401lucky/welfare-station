import { Link } from 'react-router-dom'
import { LogIn } from 'lucide-react'
import { Clover } from '@/components/Clover'
import { Button, Card, Spinner } from '@/components/ui'
import type { SelfInfo } from '@/lib/api'

/**
 * 棋盘之前的分支卡片:未登录 / 未绑定 / 加载中 / 加载失败 / 未开放。
 * 五者互斥,页面只负责算好条件传进来。
 */
export function PageStates({ me, loadingBoard, loadError, gameEnabled }: {
  me: SelfInfo | undefined
  loadingBoard: boolean
  loadError: Error | null
  gameEnabled: boolean
}) {
  if (!me) {
    return (
      <Card className="mx-auto max-w-lg p-8 text-center">
        <Clover size={44} className="mx-auto animate-sway" />
        <h2 className="mt-3 text-xl font-bold text-clover-800">先登录才能开局</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          用 LinuxDO 账号进站,成绩与额度都会记在你名下。
        </p>
        <a href="/api/oauth/linuxdo" className="mt-5 inline-block">
          <Button variant="gradient">
            <LogIn size={17} /> LinuxDO 一键进站
          </Button>
        </a>
      </Card>
    )
  }

  if (!me.bound) {
    return (
      <Card className="mx-auto max-w-lg p-8 text-center">
        <Clover size={44} className="mx-auto animate-sway" />
        <h2 className="mt-3 text-xl font-bold text-clover-800">还差一步:绑定 new-api 账号</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          绑定之后,游戏赢到的额度才知道该送去哪个钱包。
        </p>
        <Link to="/bind" className="mt-5 inline-block">
          <Button variant="gradient">去绑定引导页 →</Button>
        </Link>
      </Card>
    )
  }

  if (loadingBoard) {
    return (
      <div className="flex justify-center py-16">
        <Spinner size={40} />
      </div>
    )
  }

  if (loadError) {
    return (
      <Card className="mx-auto max-w-lg p-8 text-center">
        <Clover size={40} className="mx-auto" petal="rgb(var(--c-clover-200))" petalAlt="rgb(var(--c-clover-100))" />
        <h2 className="mt-3 text-xl font-bold text-clover-800">小游戏加载失败</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          {loadError.message || '请稍后刷新页面再试'}
        </p>
      </Card>
    )
  }

  if (!gameEnabled) {
    return (
      <Card className="mx-auto max-w-lg p-8 text-center">
        <Clover size={44} className="mx-auto" petal="rgb(var(--c-clover-200))" petalAlt="rgb(var(--c-clover-100))" />
        <h2 className="mt-3 text-xl font-bold text-clover-800">小游戏暂未开放</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          站长正在给草地浇水,过阵子再来看看吧。
        </p>
        <Link to="/" className="mt-5 inline-block">
          <Button variant="outline" size="sm">回小站签到</Button>
        </Link>
      </Card>
    )
  }

  return null
}
