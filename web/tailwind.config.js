/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // 四叶草主题色板
        clover: {
          50: '#f0f9f2',
          100: '#dcf1e2',
          200: '#bce3c9',
          300: '#8fd6a8',
          400: '#5bbc82',
          500: '#35a465',
          600: '#268552',
          700: '#1f6a44',
          800: '#1d5439',
          900: '#194630',
          ink: '#1c4a32', // 墨绿正文
        },
        gold: {
          300: '#eed9a4',
          400: '#ddb45f',
          500: '#c9963a',
          600: '#b07f27',
        },
        cream: '#faf6e8',
        border: '#dceadfcc',
        background: '#f2f8f0',
        foreground: '#1c4a32',
        muted: { DEFAULT: '#e8f2ea', foreground: '#5f8770' },
        card: { DEFAULT: '#ffffff', foreground: '#1c4a32' },
        primary: { DEFAULT: '#268552', foreground: '#ffffff' },
        destructive: { DEFAULT: '#d4574e', foreground: '#ffffff' },
        ring: '#5bbc82',
        input: '#cfe4d5',
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
        'clover-gradient': 'linear-gradient(135deg, #35a465 0%, #268552 100%)',
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
