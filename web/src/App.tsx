import { Routes, Route } from 'react-router-dom'
import HomePage from '@/pages/HomePage'
import BindPage from '@/pages/BindPage'
import RecordsPage from '@/pages/RecordsPage'
import GamePage from '@/pages/GamePage'
import AdminPage from '@/pages/AdminPage'
import { Toaster } from '@/components/Toast'

export default function App() {
  return (
    <>
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/bind" element={<BindPage />} />
        <Route path="/records" element={<RecordsPage />} />
        <Route path="/game" element={<GamePage />} />
        <Route path="/admin" element={<AdminPage />} />
        <Route path="*" element={<HomePage />} />
      </Routes>
      <Toaster />
    </>
  )
}
