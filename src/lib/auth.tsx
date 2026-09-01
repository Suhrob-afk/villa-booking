import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { callTelegramAuth, setAccessToken, supabaseConfigured } from './supabase'
import { initTelegram, onForeground, tg } from './telegram'
import { isStaleBuild } from './version'
import type { User } from './types'

type Status = 'loading' | 'needs-registration' | 'ready' | 'error'

interface AuthState {
  status: Status
  user: User | null
  error: string | null
  /** Telegram profile of someone who has not registered in the bot yet. */
  pendingTelegram: { id: number; name: string } | null
  refreshUser: (user: User) => void
  retry: () => void
}

const AuthContext = createContext<AuthState | null>(null)

/**
 * Sign-in is a pure lookup. Registration -- language, phone, name, and whether
 * someone is an owner, a makler, both, or neither -- happens in the Telegram
 * bot conversation before the Mini App is ever opened. If no users row exists
 * by the time we get here, the app sends the person back to the bot rather
 * than collecting anything itself.
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<Status>('loading')
  const [user, setUser] = useState<User | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pendingTelegram, setPendingTelegram] = useState<{ id: number; name: string } | null>(null)
  const [attempt, setAttempt] = useState(0)

  const lastRefresh = useRef(0)

  const buildPayload = useCallback(() => {
    if (!supabaseConfigured) {
      throw new Error('Supabase is not configured. Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY.')
    }
    const initData = tg()?.initData
    const devId = import.meta.env.VITE_DEV_TELEGRAM_ID as string | undefined
    const payload = initData ? { initData } : devId ? { devTelegramId: Number(devId) } : null
    if (!payload) throw new Error('Open this app from Telegram to sign in.')
    return payload
  }, [])

  const signIn = useCallback(async () => {
    setStatus('loading')
    setError(null)
    try {
      const payload = buildPayload()
      const result = await callTelegramAuth(payload)

      if (result.needsRegistration) {
        setPendingTelegram(result.telegram ?? null)
        setStatus('needs-registration')
        return
      }
      if (!result.token || !result.user) throw new Error('Sign-in returned no session.')

      setAccessToken(result.token)
      setUser(result.user)
      setStatus('ready')
    } catch (err) {
      setAccessToken(null)
      setError((err as Error).message)
      setStatus('error')
    }
  }, [buildPayload])

  /**
   * Re-check identity when the app returns to the foreground.
   *
   * Telegram reuses a live WebView when the app is reopened from the persistent
   * menu button, so mounting happens once and everything after it — including
   * the role a person just changed with /role — would otherwise stay frozen at
   * whatever was true on first load.
   *
   * Deliberately silent: no 'loading' status, so the screen the user is looking
   * at does not blink on every focus. A failure leaves the current session
   * alone rather than throwing them out.
   */
  const refresh = useCallback(async () => {
    if (Date.now() - lastRefresh.current < 3000) return
    lastRefresh.current = Date.now()

    // A kept-alive WebView can be running code from an old deploy; re-auth
    // would not help there, only a reload will.
    if (await isStaleBuild()) {
      window.location.reload()
      return
    }

    try {
      const result = await callTelegramAuth(buildPayload())
      if (result.needsRegistration) {
        setPendingTelegram(result.telegram ?? null)
        setStatus('needs-registration')
        return
      }
      if (result.token && result.user) {
        setAccessToken(result.token)
        setUser(result.user)
        setStatus('ready')
      }
    } catch {
      // Keep whatever session we already have.
    }
  }, [buildPayload])

  useEffect(() => {
    initTelegram()
    void signIn()
  }, [signIn, attempt])

  useEffect(() => {
    if (status !== 'ready' && status !== 'needs-registration') return
    return onForeground(() => void refresh())
  }, [refresh, status])

  const value = useMemo<AuthState>(
    () => ({
      status,
      user,
      error,
      pendingTelegram,
      refreshUser: setUser,
      retry: () => setAttempt((n) => n + 1),
    }),
    [status, user, error, pendingTelegram],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth(): AuthState {
  const context = useContext(AuthContext)
  if (!context) throw new Error('useAuth must be used inside <AuthProvider>')
  return context
}

/** Convenience for screens that only render once a user exists. */
export function useCurrentUser(): User {
  const { user } = useAuth()
  if (!user) throw new Error('No signed-in user')
  return user
}
