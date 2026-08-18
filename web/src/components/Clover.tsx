import { motion } from 'framer-motion'
import { cn } from '@/lib/utils'

/**
 * 四叶草 SVG:四片心形叶 + 短茎。
 * 单一色系或双色(petal / petalAlt 交替)让叶片有层次。
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
  // 单片心形叶(尖端朝下指向圆心),绕中心旋转 4 次
  const leaf =
    'M0,-4 C-1.2,-9.5 -6.5,-11.5 -9.5,-8.5 C-12.5,-5.5 -11,-1.5 -6,1.5 C-3.5,3 -1,3.5 0,3.8 C1,3.5 3.5,3 6,1.5 C11,-1.5 12.5,-5.5 9.5,-8.5 C6.5,-11.5 1.2,-9.5 0,-4 Z'
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
          d="M1.5 6 C2.5 14 6 20 10 24"
          stroke="#268552"
          strokeWidth="2.6"
          strokeLinecap="round"
          fill="none"
        />
      )}
      {[0, 90, 180, 270].map((deg, i) => (
        <g key={deg} transform={`rotate(${deg}) translate(0 -10.5)`}>
          <path d={leaf} fill={i % 2 === 0 ? petal : petalAlt} />
        </g>
      ))}
      <circle cx="0" cy="0" r="1.6" fill="#1f6a44" />
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

/** 加载指示:旋转的四叶草(转运中…) */
export function CloverSpinner({ size = 28, className }: { size?: number; className?: string }) {
  return (
    <span className={cn('inline-flex', className)}>
      <Clover size={size} stem={false} className="animate-[spin-slow_1.6s_linear_infinite]" />
    </span>
  )
}

/** 固定背景层:几片漂浮的半透明四叶草 */
const floaters = [
  { top: '12%', left: '5%', size: 34, delay: '0s', opacity: 0.5 },
  { top: '30%', left: '92%', size: 46, delay: '1.4s', opacity: 0.45 },
  { top: '64%', left: '8%', size: 26, delay: '2.6s', opacity: 0.4 },
  { top: '78%', left: '88%', size: 30, delay: '0.8s', opacity: 0.42 },
  { top: '8%', left: '72%', size: 22, delay: '3.4s', opacity: 0.38 },
  { top: '46%', left: '96%', size: 20, delay: '2s', opacity: 0.32 },
]

export function FloatingClovers() {
  return (
    <div className="pointer-events-none fixed inset-0 z-0 overflow-hidden" aria-hidden>
      {floaters.map((f, i) => (
        <span
          key={i}
          className="absolute animate-float-leaf"
          style={{ top: f.top, left: f.left, opacity: f.opacity, animationDelay: f.delay }}
        >
          <Clover size={f.size} stem={false} petal="#8fd6a8" petalAlt="#bce3c9" />
        </span>
      ))}
    </div>
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
