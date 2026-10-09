import { useEffect } from 'react'
import { BrowserRouter, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom'
import { AuthProvider, useAuth } from './lib/auth'
import { LanguageProvider, useI18n } from './lib/i18n'
import { colorScheme, launchVillaCode } from './lib/telegram'
import { ErrorState, Loading, OfflineBanner, TabBar, type Tab } from './components/ui'
import BookingScreen from './screens/BookingScreen'
import Breakdown from './screens/Breakdown'
import Dashboard from './screens/Dashboard'
import Home from './screens/Home'
import Onboarding from './screens/Onboarding'
import PublicVilla from './screens/PublicVilla'
import VillaCalendar from './screens/VillaCalendar'
import VillaSetup from './screens/VillaSetup'

/**
 * A villa's public booking link (t.me/oikoz_villa_bot/open?startapp=villa_id0001)
 * opens the Mini App at its root with that code as start_param. Point the
 * first screen at the booking page instead of Home -- once, before the router
 * reads the URL, and only from the root, so a reload deeper in the app stays
 * where it was. The hash is kept: Telegram's launch parameters live there.
 */
function routeLaunchLink(): void {
  const code = launchVillaCode()
  if (!code || window.location.pathname.replace(/\/+$/, '') !== '') return
  window.history.replaceState(
    window.history.state,
    '',
    `/v/${encodeURIComponent(code)}${window.location.search}${window.location.hash}`,
  )
}

routeLaunchLink()

function Shell() {
  const { status, error, retry, user } = useAuth()
  const { t } = useI18n()
  const location = useLocation()
  const navigate = useNavigate()

  // The public booking page talks to its own Edge Functions with initData, so
  // it does not depend on sign-in succeeding: a link to an archived villa
  // registers nobody (needs-registration) and still deserves its own
  // "not found" page rather than the bot's onboarding prompt.
  const onPublicPage = location.pathname.startsWith('/v/')

  if (status === 'loading') return <Loading label={t('common.signingIn')} />
  if (!onPublicPage) {
    if (status === 'error') return <ErrorState message={error ?? t('common.signInFailed')} onRetry={retry} />
    if (status === 'needs-registration') return <Onboarding />
  }

  const activeTab: Tab = location.pathname.startsWith('/dashboard') ? 'dashboard' : 'villas'
  // Clients (neither flag) get the placeholder only -- no tabs to wander into.
  // Nobody gets tabs on the public page: it is a destination, not a section.
  const showTabs = !onPublicPage && Boolean(user?.is_owner || user?.is_makler)

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
        <Route path="/v/:villaCode" element={<PublicVilla />} />
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
