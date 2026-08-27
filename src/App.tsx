import { useEffect } from 'react'
import { BrowserRouter, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom'
import { AuthProvider, useAuth } from './lib/auth'
import { colorScheme } from './lib/telegram'
import { ErrorState, Loading, TabBar, type Tab } from './components/ui'
import BookingScreen from './screens/BookingScreen'
import Commissions from './screens/Commissions'
import Home from './screens/Home'
import RoleSelect from './screens/RoleSelect'
import VillaCalendar from './screens/VillaCalendar'
import VillaSetup from './screens/VillaSetup'

function Shell() {
  const { status, error, retry } = useAuth()
  const location = useLocation()
  const navigate = useNavigate()

  if (status === 'loading') return <Loading label="Signing you in…" />
  if (status === 'error') return <ErrorState message={error ?? 'Sign-in failed.'} onRetry={retry} />
  if (status === 'needs-role') return <RoleSelect />

  const activeTab: Tab = location.pathname.startsWith('/commissions') ? 'commissions' : 'villas'

  return (
    <>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/commissions" element={<Commissions />} />
        <Route path="/villa/new" element={<VillaSetup />} />
        <Route path="/villa/:villaId" element={<VillaCalendar />} />
        <Route path="/villa/:villaId/setup" element={<VillaSetup />} />
        <Route path="/villa/:villaId/booking/new" element={<BookingScreen />} />
        <Route path="/booking/:bookingId" element={<BookingScreen />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
      <TabBar active={activeTab} onChange={(tab) => navigate(tab === 'villas' ? '/' : '/commissions')} />
    </>
  )
}

export default function App() {
  useEffect(() => {
    document.documentElement.dataset.theme = colorScheme()
  }, [])

  return (
    <AuthProvider>
      <BrowserRouter>
        <div className="app">
          <Shell />
        </div>
      </BrowserRouter>
    </AuthProvider>
  )
}
