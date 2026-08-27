import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { callTelegramAuth, setAccessToken, supabaseConfigured } from './supabase'
import { initTelegram, tg } from './telegram'
import type { Role, User } from './types'

type Status = 'loading' | 'needs-role' | 'ready' | 'error'

interface AuthState {
  status: Status
  user: User | null
  error: string | null
  /** Telegram profile of a first-time user, shown on the role picker. */
  pendingTelegram: { id: number; name: string } | null
  chooseRole: (role: Role) => Promise<void>
  refreshUser: (user: User) => void
  retry: () => void
}

const AuthContext = createContext<AuthState | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<Status>('loading')
  const [user, setUser] = useState<User | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pendingTelegram, setPendingTelegram] = useState<{ id: number; name: string } | null>(null)
  const [attempt, setAttempt] = useState(0)

  const signIn = useCallback(async (role?: Role) => {
    setStatus('loading')
    setError(null)
    try {
      if (!supabaseConfigured) {
        throw new Error('Supabase is not configured. Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY.')
      }
      const initData = tg()?.initData
      const devId = import.meta.env.VITE_DEV_TELEGRAM_ID as string | undefined

      const payload = initData
        ? { initData, role }
        : devId
          ? { devTelegramId: Number(devId), role }
          : null

      if (!payload) throw new Error('Open this app from Telegram to sign in.')

      const result = await callTelegramAuth(payload)

      if (result.needsRole) {
        setPendingTelegram(result.telegram ?? null)
        setStatus('needs-role')
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
  }, [])

  useEffect(() => {
    initTelegram()
    void signIn()
  }, [signIn, attempt])

  const value = useMemo<AuthState>(
    () => ({
      status,
      user,
      error,
      pendingTelegram,
      chooseRole: (role: Role) => signIn(role),
      refreshUser: setUser,
      retry: () => setAttempt((n) => n + 1),
    }),
    [status, user, error, pendingTelegram, signIn],
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
