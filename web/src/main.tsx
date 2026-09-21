import React from 'react'
import ReactDOM from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { BrowserRouter } from 'react-router-dom'
import App from './App'
import { applyTheme, readTheme, watchSystemTheme } from './lib/theme'
import './index.css'

// 首帧的 dark 类已由 index.html 的内联脚本加上(避免闪白);这里补上 meta 同步
// 与"跟随系统"期间的系统偏好监听。
applyTheme(readTheme())
watchSystemTheme()

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
})

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </QueryClientProvider>
  </React.StrictMode>,
)
