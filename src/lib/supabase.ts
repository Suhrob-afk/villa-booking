import { createClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL as string
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string

if (!url || !anonKey) {
  // Surfaced in the UI by App.tsx rather than crashing on a blank screen.
  console.error('VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY are not set. Copy .env.example to .env.')
}

/**
 * The Telegram-minted JWT lives here rather than in Supabase's own auth
 * storage: we never use GoTrue sessions, we just sign our own token in the
 * telegram-auth Edge Function and attach it to every PostgREST request.
 */
let accessToken: string | null = null

export function setAccessToken(token: string | null): void {
  accessToken = token
}

const authedFetch: typeof fetch = (input, init = {}) => {
  const headers = new Headers(init.headers ?? {})
  if (accessToken) headers.set('Authorization', `Bearer ${accessToken}`)
  return fetch(input, { ...init, headers })
}

export const supabase = createClient(url ?? '', anonKey ?? '', {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  global: { fetch: authedFetch },
})

export const supabaseConfigured = Boolean(url && anonKey)

export interface AuthResponse {
  token?: string
  expiresAt?: number
  user?: import('./types').User
  needsRole?: boolean
  telegram?: { id: number; name: string }
  error?: string
}

/** Calls the telegram-auth Edge Function directly (it is not a GoTrue route). */
export async function callTelegramAuth(payload: {
  initData?: string
  devTelegramId?: number
  role?: 'owner' | 'manager'
  name?: string
}): Promise<AuthResponse> {
  const response = await fetch(`${url}/functions/v1/telegram-auth`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: anonKey, Authorization: `Bearer ${anonKey}` },
    body: JSON.stringify(payload),
  })
  const body = (await response.json().catch(() => ({}))) as AuthResponse
  if (!response.ok) throw new Error(body.error ?? `Sign-in failed (${response.status})`)
  return body
}
