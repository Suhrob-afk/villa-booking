import { useState } from 'react'
import { useAuth } from '../lib/auth'
import { Alert } from '../components/ui'

/** Shown once, on a person's very first sign-in. The role is stored on users.role. */
export default function RoleSelect() {
  const { chooseRole, pendingTelegram, error } = useAuth()
  const [busy, setBusy] = useState(false)

  async function pick(role: 'owner' | 'manager') {
    setBusy(true)
    await chooseRole(role)
    setBusy(false)
  }

  return (
    <div className="center-state">
      <h2>Welcome{pendingTelegram ? `, ${pendingTelegram.name}` : ''}</h2>
      <p>How do you use Villa CRM? This sets up your account and can’t be switched later on your own.</p>
      {error && <Alert>{error}</Alert>}
      <div className="role-cards">
        <button type="button" className="role-card" disabled={busy} onClick={() => void pick('owner')}>
          <strong>I own villas</strong>
          <span>Set rates and commission, see the calendar, and settle what you owe managers.</span>
        </button>
        <button type="button" className="role-card" disabled={busy} onClick={() => void pick('manager')}>
          <strong>I manage bookings</strong>
          <span>Take bookings on the villas owners assign you, and track your commission.</span>
        </button>
      </div>
    </div>
  )
}
