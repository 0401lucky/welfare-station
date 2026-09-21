/** @type {import('tailwindcss').Config} */
// 色板全部走 CSS 变量(index.css 的 :root / .dark),深色模式只改变量不动组件。
// 每个变量存的是 "R G B" 三元组,配合 <alpha-value> 保住 Tailwind 的 /50 透明度语法。
const v = (name) => `rgb(var(${name}) / <alpha-value>)`

export default {
  darkMode: 'class',
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // 四叶草主题色板
        clover: {
          50: v('--c-clover-50'),
          100: v('--c-clover-100'),
          200: v('--c-clover-200'),
          300: v('--c-clover-300'),
          400: v('--c-clover-400'),
          500: v('--c-clover-500'),
          600: v('--c-clover-600'),
          700: v('--c-clover-700'),
          800: v('--c-clover-800'),
          900: v('--c-clover-900'),
          ink: v('--c-clover-ink'),
          // 实心按钮专用的深绿:浅色下 700/800 是"可作为按钮底色"的深绿,
          // 深色下 700/800 要变亮当文字用,于是把按钮底色单独拎出来,两边互不影响。
          solid: v('--c-clover-solid'),
          'solid-strong': v('--c-clover-solid-strong'),
          'solid-soft': v('--c-clover-solid-soft'),
        },
        gold: {
          300: v('--c-gold-300'),
          400: v('--c-gold-400'),
          500: v('--c-gold-500'),
          600: v('--c-gold-600'),
        },
        // 面板底色:浅色是纯白,深色是深绿灰。所有 bg-white 已改用 bg-surface。
        surface: v('--c-surface'),
        cream: v('--c-cream'),
        border: 'rgb(var(--c-border) / 0.8)',
        background: v('--c-background'),
        foreground: v('--c-foreground'),
        muted: { DEFAULT: v('--c-muted'), foreground: v('--c-muted-foreground') },
        card: { DEFAULT: v('--c-card'), foreground: v('--c-card-foreground') },
        primary: { DEFAULT: v('--c-primary'), foreground: v('--c-primary-foreground') },
        destructive: { DEFAULT: v('--c-destructive'), foreground: v('--c-destructive-foreground') },
        ring: v('--c-ring'),
        input: v('--c-input'),
      },
      fontFamily: {
        sans: ['"Noto Sans SC"', 'system-ui', 'sans-serif'],
        kai: ['"Ma Shan Zheng"', '"Noto Serif SC"', 'serif'], // 书法标题
        serif: ['"Noto Serif SC"', 'serif'],
      },
      borderRadius: {
        lg: '1rem',
        xl: '1.25rem',
        '2xl': '1.5rem',
        '3xl': '2rem',
      },
      boxShadow: {
        leaf: '0 10px 34px -12px rgba(38, 133, 82, 0.28)',
        'leaf-sm': '0 4px 16px -6px rgba(38, 133, 82, 0.22)',
        card: '0 8px 32px -14px rgba(31, 106, 68, 0.18), 0 2px 8px -4px rgba(31, 106, 68, 0.08)',
      },
      backgroundImage: {
        // 主按钮渐变也走变量:浅色与改造前一致,深色压深以保住白字对比度。
        'clover-gradient': 'linear-gradient(135deg, rgb(var(--c-gradient-from)) 0%, rgb(var(--c-gradient-to)) 100%)',
        // 进度条是装饰性色带,深色下同样清晰,保持固定值。
        'lucky-bar': 'linear-gradient(90deg, #5bbc82 0%, #8fd6a8 45%, #ddb45f 100%)',
      },
      keyframes: {
        'float-leaf': {
          '0%, 100%': { transform: 'translateY(0) rotate(-6deg)' },
          '50%': { transform: 'translateY(-18px) rotate(10deg)' },
        },
        sway: {
          '0%, 100%': { transform: 'rotate(-8deg)' },
          '50%': { transform: 'rotate(8deg)' },
        },
        'spin-slow': {
          from: { transform: 'rotate(0deg)' },
          to: { transform: 'rotate(360deg)' },
        },
        'pop-in': {
          '0%': { transform: 'scale(0.4)', opacity: '0' },
          '60%': { transform: 'scale(1.12)', opacity: '1' },
          '100%': { transform: 'scale(1)', opacity: '1' },
        },
        'pulse-dot': {
          '0%, 100%': { opacity: '1' },
          '50%': { opacity: '0.35' },
        },
        'fade-up': {
          from: { opacity: '0', transform: 'translateY(14px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
      },
      animation: {
        'float-leaf': 'float-leaf 7s ease-in-out infinite',
        sway: 'sway 3.2s ease-in-out infinite',
        'spin-slow': 'spin-slow 14s linear infinite',
        'pop-in': 'pop-in 0.5s cubic-bezier(0.34, 1.56, 0.64, 1)',
        'pulse-dot': 'pulse-dot 1.8s ease-in-out infinite',
        'fade-up': 'fade-up 0.55s ease-out both',
      },
    },
  },
  plugins: [],
}
