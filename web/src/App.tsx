import { lazy, Suspense } from 'react'
import { Routes, Route, Navigate } from 'react-router-dom'
import HomePage from '@/pages/HomePage'
import BindPage from '@/pages/BindPage'
import RecordsPage from '@/pages/RecordsPage'
import GamePage from '@/pages/GamePage'
import ArcadePage from '@/pages/ArcadePage'
import WatermelonPage from '@/pages/WatermelonPage'
import { Toaster } from '@/components/Toast'
import { Spinner } from '@/components/ui'

const AdminPage = lazy(() => import('@/pages/AdminPage'))

export default function App() {
  return (
    <>
      <Suspense fallback={<div className="flex min-h-screen items-center justify-center" role="status" aria-label="正在加载页面"><Spinner size={36} /></div>}>
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/bind" element={<BindPage />} />
          <Route path="/records" element={<RecordsPage />} />
          <Route path="/game" element={<ArcadePage />} />
          <Route path="/game/2048" element={<GamePage />} />
          <Route path="/game/watermelon" element={<WatermelonPage />} />
          <Route path="/game/:gameId" element={<Navigate to="/game" replace />} />
          <Route path="/admin" element={<AdminPage />} />
          <Route path="*" element={<HomePage />} />
        </Routes>
      </Suspense>
      <Toaster />
    </>
  )
}
