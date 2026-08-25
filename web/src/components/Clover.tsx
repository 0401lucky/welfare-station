import { motion } from 'framer-motion'
import { cn } from '@/lib/utils'

/**
 * 四叶草 SVG:四片饱满心形叶 + 细长弧茎。
 * 单一色系或双色(petal / petalAlt 交替)让叶片有层次。
 *
 * 叶片的尖端收在圆心(0,0),四片各旋转 90° 铺成十字,相邻叶之间留下的细缝
 * 自然构成对角白线——这是参考图的关键特征,所以中心不再需要补圆点遮挡空隙。
 */
export function Clover({
  size = 24,
  className,
  petal = '#35a465',
  petalAlt = '#5bbc82',
  stem = true,
}: {
  size?: number
  className?: string
  petal?: string
  petalAlt?: string
  stem?: boolean
}) {
  // 单片心形叶:尖端在原点,两个圆润的裂片朝外(-y 方向)张开。
  // 起笔从尖端往左外扩到左裂片顶,过中间的凹口,再对称回到尖端。
  const leaf =
    'M0,0 C-3.6,-4.2 -8.2,-6.0 -11.4,-6.0 C-16.4,-6.0 -19.6,-9.8 -19.6,-14.0 C-19.6,-18.4 -16.0,-21.4 -11.6,-21.4 C-6.4,-21.4 -2.2,-17.6 -1.1,-12.4 C-0.7,-10.6 -0.3,-7.6 0,-4.6 C0.3,-7.6 0.7,-10.6 1.1,-12.4 C2.2,-17.6 6.4,-21.4 11.6,-21.4 C16.0,-21.4 19.6,-18.4 19.6,-14.0 C19.6,-9.8 16.4,-6.0 11.4,-6.0 C8.2,-6.0 3.6,-4.2 0,0 Z'
  return (
    <svg
      width={size}
      height={size}
      viewBox="-24 -24 48 52"
      fill="none"
      className={className}
      aria-hidden
    >
      {stem && (
        <path
          d="M0.6 3 C1.6 11 3.4 18 7.6 23.2"
          stroke="#3aa869"
          strokeWidth="2.4"
          strokeLinecap="round"
          fill="none"
        />
      )}
      {[0, 90, 180, 270].map((deg, i) => (
        <g key={deg} transform={`rotate(${deg})`}>
          <path d={leaf} fill={i % 2 === 0 ? petal : petalAlt} />
        </g>
      ))}
    </svg>
  )
}

/** 主视觉:虚线圆环 + 缓慢自转的四叶草(参考图 hero) */
export function CloverEmblem({ size = 120, className }: { size?: number; className?: string }) {
  return (
    <div
      className={cn('relative inline-flex items-center justify-center', className)}
      style={{ width: size, height: size }}
    >
      <div className="ring-dashed absolute inset-0 animate-spin-slow rounded-full" />
      <div className="absolute inset-[9%] rounded-full bg-white/80 shadow-leaf-sm" />
      <Clover size={size * 0.58} className="relative animate-sway" />
    </div>
  )
}

/**
 * 加载指示:旋转的四叶草(转运中…)。
 * 花瓣取 currentColor:放进白字按钮(gradient/danger)自动变白,
 * 普通语境跟随正文墨绿,调用方无需传色。
 */
export function CloverSpinner({ size = 28, className }: { size?: number; className?: string }) {
  return (
    <span className={cn('inline-flex', className)}>
      <Clover
        size={size}
        stem={false}
        petal="currentColor"
        petalAlt="currentColor"
        className="animate-[spin-slow_1.6s_linear_infinite]"
      />
    </span>
  )
}

/** 签到成功:四叶草雨 */
export function CloverRain({ seed }: { seed: number }) {
  const drops = Array.from({ length: 16 }, (_, i) => {
    const r = Math.abs(Math.sin(seed * 97 + i * 13.7))
    const r2 = Math.abs(Math.sin(seed * 41 + i * 7.3))
    return {
      left: 4 + r * 92,
      delay: r2 * 0.7,
      size: 14 + r2 * 18,
      drift: (r - 0.5) * 120,
      duration: 1.6 + r * 1.2,
      gold: i % 5 === 0,
    }
  })
  return (
    <div className="pointer-events-none fixed inset-0 z-[60] overflow-hidden" aria-hidden>
      {drops.map((d, i) => (
        <motion.span
          key={`${seed}-${i}`}
          className="absolute top-[-40px]"
          style={{ left: `${d.left}%` }}
          initial={{ y: -60, x: 0, opacity: 0, rotate: 0 }}
          animate={{ y: '106vh', x: d.drift, opacity: [0, 1, 1, 0.7], rotate: 360 + d.drift }}
          transition={{ duration: d.duration, delay: d.delay, ease: 'easeIn' }}
        >
          {d.gold ? (
            <Clover size={d.size} stem={false} petal="#ddb45f" petalAlt="#eed9a4" />
          ) : (
            <Clover size={d.size} stem={false} />
          )}
        </motion.span>
      ))}
    </div>
  )
}
