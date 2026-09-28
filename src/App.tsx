import { useEffect } from 'react'
import { BrowserRouter, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom'
import { AuthProvider, useAuth } from './lib/auth'
import { LanguageProvider, useI18n } from './lib/i18n'
import { colorScheme } from './lib/telegram'
import { ErrorState, Loading, OfflineBanner, TabBar, type Tab } from './components/ui'
import BookingScreen from './screens/BookingScreen'
import Breakdown from './screens/Breakdown'
import Dashboard from './screens/Dashboard'
import Home from './screens/Home'
import Onboarding from './screens/Onboarding'
import VillaCalendar from './screens/VillaCalendar'
import VillaSetup from './screens/VillaSetup'

function Shell() {
  const { status, error, retry, user } = useAuth()
  const { t } = useI18n()
  const location = useLocation()
  const navigate = useNavigate()

  if (status === 'loading') return <Loading label={t('common.signingIn')} />
  if (status === 'error') return <ErrorState message={error ?? t('common.signInFailed')} onRetry={retry} />
  if (status === 'needs-registration') return <Onboarding />

  const activeTab: Tab = location.pathname.startsWith('/dashboard') ? 'dashboard' : 'villas'
  // Clients (neither flag) get the placeholder only -- no tabs to wander into.
  const showTabs = Boolean(user?.is_owner || user?.is_makler)

  return (
    <>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/dashboard" element={<Dashboard />} />
        {/* The tab was called Commissions before it grew an Overview. */}
        <Route path="/commissions" element={<Navigate to="/dashboard" replace />} />
        <Route path="/villa/new" element={<VillaSetup />} />
        <Route path="/villa/:villaId" element={<VillaCalendar />} />
        <Route path="/villa/:villaId/setup" element={<VillaSetup />} />
        <Route path="/villa/:villaId/breakdown" element={<Breakdown />} />
        <Route path="/villa/:villaId/booking/new" element={<BookingScreen />} />
        <Route path="/booking/:bookingId" element={<BookingScreen />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
      {showTabs && (
        <TabBar active={activeTab} onChange={(tab) => navigate(tab === 'villas' ? '/' : '/dashboard')} />
      )}
    </>
  )
}

export default function App() {
  useEffect(() => {
    document.documentElement.dataset.theme = colorScheme()
  }, [])

  return (
    <AuthProvider>
      <LanguageProvider>
        <BrowserRouter>
          <div className="app">
            <OfflineBanner />
            <Shell />
          </div>
        </BrowserRouter>
      </LanguageProvider>
    </AuthProvider>
  )
}
