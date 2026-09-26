import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './styles.css'

const root = createRoot(document.getElementById('root')!)

/**
 * The admin panel is not part of the Mini App. Branching here -- before either
 * side is imported -- is what makes that true rather than merely intended: on
 * /admin the app's bundle is never loaded, so no auth flow runs, no Telegram
 * bridge is touched, and no router mounts. Each side is a separate chunk.
 */
const path = window.location.pathname.replace(/\/+$/, '')

if (path === '/admin') {
  void import('./admin/AdminPage').then(({ default: AdminPage }) =>
    root.render(
      <StrictMode>
        <AdminPage />
      </StrictMode>,
    ),
  )
} else {
  void import('./App').then(({ default: App }) =>
    root.render(
      <StrictMode>
        <App />
      </StrictMode>,
    ),
  )
}
