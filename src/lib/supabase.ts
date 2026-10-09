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

export function getAccessToken(): string | null {
  return accessToken
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
  /**
   * No users row for this Telegram id. Registration happens in the bot
   * conversation before the Mini App is ever opened, so there is nothing for
   * the app to collect -- it just points the person back at the bot.
   */
  needsRegistration?: boolean
  telegram?: { id: number; name: string }
  error?: string
}

/** Calls the telegram-auth Edge Function directly (it is not a GoTrue route). */
export async function callTelegramAuth(payload: {
  initData?: string
  devTelegramId?: number
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

/**
 * POSTs to an Edge Function that authenticates the caller itself (the public
 * booking functions verify Telegram initData), returning the parsed body and
 * status whether or not the call succeeded. Network failures still throw.
 */
export async function callEdgeFunction<T>(name: string, body: unknown): Promise<{ status: number; body: T }> {
  const response = await fetch(`${url}/functions/v1/${name}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: anonKey, Authorization: `Bearer ${anonKey}` },
    body: JSON.stringify(body),
  })
  return { status: response.status, body: (await response.json().catch(() => ({}))) as T }
}
