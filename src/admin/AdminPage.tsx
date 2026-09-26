/**
 * The standalone admin panel.
 *
 * Intentionally isolated from the Mini App: it imports nothing from lib/auth,
 * lib/telegram, lib/supabase, the screens or the router, holds no Telegram
 * context, and is reached in an ordinary browser tab. The only thing it shares
 * is the stylesheet.
 *
 * That isolation is also why the copy here is English-only -- the app's
 * translation layer reads the signed-in user's language, and there is no
 * signed-in user on this page.
 *
 * The password lives in component state for as long as the tab is open and
 * nowhere else: no localStorage, no sessionStorage, no cookie. Reloading the
 * page means entering it again, which is the right trade for occasional use.
 */

import { useState, type FormEvent } from 'react'

interface AdminUser {
  name: string | null
  phone: string | null
  oikoz_id: string
  is_owner: boolean
  is_makler: boolean
  language: string
  created_at: string
}

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL as string
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY as string

function roleOf(user: AdminUser): string {
  if (user.is_owner && user.is_makler) return 'Owner & Makler'
  if (user.is_owner) return 'Owner'
  if (user.is_makler) return 'Makler'
  return 'Client'
}

export default function AdminPage() {
  const [password, setPassword] = useState('')
  const [users, setUsers] = useState<AdminUser[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (!password || busy) return

    setBusy(true)
    setError(null)
    try {
      const response = await fetch(`${SUPABASE_URL}/functions/v1/admin-users`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          apikey: SUPABASE_ANON_KEY,
          Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
        },
        body: JSON.stringify({ password }),
      })

      const body = await response.json().catch(() => ({}))
      if (!response.ok) {
        setError(body?.error ?? `Request failed (${response.status})`)
        return
      }

      setUsers(body.users ?? [])
      // Nothing more needs it, so stop holding it.
      setPassword('')
    } catch {
      setError('Could not reach the server. Check your connection and try again.')
    } finally {
      setBusy(false)
    }
  }

  if (!users) {
    return (
      <main className="admin">
        <div className="card card-pad admin-gate">
          <h1 className="admin-title">Admin</h1>
          <form onSubmit={submit}>
            <div className="field">
              <label htmlFor="admin-password">Password</label>
              <input
                id="admin-password"
                type="password"
                autoComplete="off"
                autoFocus
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>
            {error && <div className="alert alert-error">{error}</div>}
            <button type="submit" className="button" disabled={busy || !password}>
              {busy ? 'Checking…' : 'Open'}
            </button>
          </form>
        </div>
      </main>
    )
  }

  return (
    <main className="admin">
      <div className="admin-head">
        <h1 className="admin-title">Users</h1>
        <span className="badge">{users.length}</span>
      </div>

      {users.length === 0 ? (
        <div className="card empty">
          <strong>No users yet</strong>
        </div>
      ) : (
        <div className="card admin-table-wrap">
          <table className="admin-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Phone</th>
                <th>Oikoz ID</th>
                <th>Role</th>
                <th>Lang</th>
                <th>Joined</th>
              </tr>
            </thead>
            <tbody>
              {users.map((user) => (
                <tr key={user.oikoz_id}>
                  <td>{user.name?.trim() || '—'}</td>
                  <td>{user.phone || '—'}</td>
                  <td className="admin-mono">{user.oikoz_id}</td>
                  <td>{roleOf(user)}</td>
                  <td>{user.language?.toUpperCase() || '—'}</td>
                  <td>{user.created_at?.slice(0, 10) || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </main>
  )
}
