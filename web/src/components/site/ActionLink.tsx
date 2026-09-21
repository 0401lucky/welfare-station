import type { AnchorHTMLAttributes } from 'react'
import { Link, type LinkProps } from 'react-router-dom'
import { cn } from '@/lib/utils'

type ActionAppearance = {
  variant?: 'default' | 'outline' | 'ghost' | 'danger' | 'gradient' | 'gold'
  size?: 'sm' | 'md' | 'lg'
  className?: string
}

export function siteActionClass({ variant = 'default', size = 'md', className }: ActionAppearance = {}) {
  const variants = {
    default: 'bg-clover-solid text-white shadow-leaf-sm hover:bg-clover-solid-strong',
    gradient: 'bg-clover-gradient text-white shadow-leaf-sm hover:brightness-105',
    gold: 'border border-gold-300 bg-cream text-clover-800 hover:border-gold-400',
    outline: 'border border-clover-200 bg-surface/80 text-clover-800 hover:border-clover-400 hover:bg-clover-50',
    ghost: 'text-clover-700 hover:bg-clover-100/70',
    danger: 'bg-destructive text-white hover:brightness-95',
  }
  const sizes = { sm: 'min-h-10 px-3.5 text-sm', md: 'min-h-11 px-5 text-sm', lg: 'min-h-12 px-6 text-base' }
  return cn(
    'inline-flex shrink-0 items-center justify-center gap-2 rounded-full py-2 font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-clover-500 focus-visible:ring-offset-2',
    variants[variant], sizes[size], className,
  )
}

type ActionLinkProps = ActionAppearance & (
  | (Omit<LinkProps, 'className'> & { href?: never })
  | (Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'className'> & { href: string; to?: never })
)

/** A navigation action is one link, never a button nested inside a link. */
export function ActionLink({ variant, size, className, ...props }: ActionLinkProps) {
  const classes = siteActionClass({ variant, size, className })
  if ('to' in props && props.to != null) return <Link {...props as LinkProps} className={classes} />
  return <a {...props as AnchorHTMLAttributes<HTMLAnchorElement>} className={classes} />
}
