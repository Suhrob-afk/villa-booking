/**
 * Owner subscriptions, as the app sees them (migration 0024).
 *
 * The database is the real gate: its triggers refuse a change to a villa whose
 * owner is not paid, and creating a villa without a subscription. Everything
 * here only mirrors that so the UI can disable those actions and say why,
 * instead of letting someone fill in a form that will be refused.
 *
 *   * A change to a villa follows THAT VILLA'S OWNER, whoever makes it: a
 *     makler is read-only on a lapsed owner's villa and never charged.
 *   * Creating a villa follows the person creating it.
 *   * Active means paid_until + 3 days of grace is still ahead.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { useAuth } from './auth'
import { MONTHS_SHORT } from './strings'
import { supabase } from './supabase'
import { canOpenTelegramLink, onForeground, openTelegramLink } from './telegram'
import type { Lang, Villa } from './types'

/** Mirrors has_active_subscription(): the grace after paid_until. */
const GRACE_MS = 3 * 24 * 60 * 60 * 1000

export const SUBSCRIPTION_PRICE_UZS = 49_000
export const SUBSCRIPTION_DAYS = 30

/**
 * active  paid_until is ahead
 * grace   it passed under 3 days ago: still writable
 * lapsed  past the grace: read-only
 * never   no payment ever
 */
export type SubscriptionState = 'active' | 'grace' | 'lapsed' | 'never'

export function subscriptionState(paidUntil: string | null, now = Date.now()): SubscriptionState {
  if (!paidUntil) return 'never'
  const until = Date.parse(paidUntil)
  if (until > now) return 'active'
  return until + GRACE_MS > now ? 'grace' : 'lapsed'
}

export const isWritable = (state: SubscriptionState) => state === 'active' || state === 'grace'

/** When the grace ends, i.e. the last moment it is still writable. */
export function graceEndsAt(paidUntil: string): string {
  return new Date(Date.parse(paidUntil) + GRACE_MS).toISOString()
}

/**
 * "12 Nov" in Tashkent. Built from Intl parts, never from toISOString(),
 * which would roll a date back on this UTC+5 side of the world.
 */
export function formatDayMonth(iso: string, lang: Lang): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tashkent',
    month: 'numeric',
    day: 'numeric',
  }).formatToParts(new Date(iso))
  // Number(): en-CA zero-pads the day even when asked for 'numeric'.
  const day = Number(parts.find((p) => p.type === 'day')?.value ?? 1)
  const month = Number(parts.find((p) => p.type === 'month')?.value ?? 1)
  return `${day} ${MONTHS_SHORT[lang][month - 1]}`
}

/**
 * Opens the bot's /subscribe flow. In Telegram the chat opens over the Mini
 * App; elsewhere it is an ordinary link.
 */
const SUBSCRIBE_URL = 'https://t.me/oikoz_villa_bot?start=subscribe'

export function openSubscribe(): void {
  if (canOpenTelegramLink()) {
    try {
      if (openTelegramLink(SUBSCRIBE_URL)) return
    } catch {
      // Fall through to a plain link.
    }
  }
  window.open(SUBSCRIBE_URL, '_blank', 'noopener')
}

// ------------------------------------------------------ my subscription ----

interface MySubscription {
  /** Null until the first load finishes. */
  state: SubscriptionState | null
  paidUntil: string | null
  refresh: () => void
}

const SubscriptionContext = createContext<MySubscription | null>(null)

/**
 * The signed-in user's own subscription. Reloaded when the app returns to the
 * foreground, so a payment confirmed in the bot shows up on the next open.
 */
export function SubscriptionProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth()
  const userId = user?.id ?? null
  const [paidUntil, setPaidUntil] = useState<string | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    if (!userId) return
    let cancelled = false
    supabase
      .from('subscriptions')
      .select('paid_until')
      .eq('user_id', userId)
      .maybeSingle()
      .then(({ data, error }) => {
        if (cancelled) return
        // Before 0024 is applied the table does not exist: treat that like
        // "not known" rather than "lapsed", and let the database decide.
        if (error) {
          setLoaded(false)
          return
        }
        setPaidUntil((data?.paid_until as string | null | undefined) ?? null)
        setLoaded(true)
      })
    return () => {
      cancelled = true
    }
  }, [userId, attempt])

  const refresh = useCallback(() => setAttempt((n) => n + 1), [])
  useEffect(() => onForeground(refresh), [refresh])

  const value = useMemo<MySubscription>(
    () => ({ state: loaded ? subscriptionState(paidUntil) : null, paidUntil, refresh }),
    [loaded, paidUntil, refresh],
  )
  return <SubscriptionContext.Provider value={value}>{children}</SubscriptionContext.Provider>
}

export function useMySubscription(): MySubscription {
  const context = useContext(SubscriptionContext)
  if (!context) throw new Error('useMySubscription must be used inside <SubscriptionProvider>')
  return context
}

// ------------------------------------------------- can this villa change ----

/**
 * open           writable (or not known yet -- the database decides)
 * own_lapsed     the signed-in user owns it and is not paid
 * owner_lapsed   somebody else owns it, and they are not paid
 */
export type VillaAccess = 'open' | 'own_lapsed' | 'owner_lapsed'

const ownerCache = new Map<string, { active: boolean; at: number }>()
const OWNER_CACHE_MS = 60_000

async function ownerIsActive(ownerId: string): Promise<boolean | null> {
  const cached = ownerCache.get(ownerId)
  if (cached && Date.now() - cached.at < OWNER_CACHE_MS) return cached.active
  const { data, error } = await supabase.rpc('has_active_subscription', { p_user_id: ownerId })
  if (error) return null
  ownerCache.set(ownerId, { active: data === true, at: Date.now() })
  return data === true
}

/** Whether changes to this villa are allowed right now, and if not, whose subscription it is. */
export function useVillaWriteAccess(villa: Pick<Villa, 'owner_id'> | null): VillaAccess {
  const { user } = useAuth()
  const mine = useMySubscription()
  const ownerId = villa?.owner_id ?? null
  const isMine = Boolean(ownerId && user && ownerId === user.id)
  const [ownerActive, setOwnerActive] = useState<boolean | null>(null)

  useEffect(() => {
    if (!ownerId || isMine) return
    let cancelled = false
    void ownerIsActive(ownerId).then((active) => {
      if (!cancelled) setOwnerActive(active)
    })
    return () => {
      cancelled = true
    }
  }, [ownerId, isMine])

  if (!ownerId) return 'open'
  if (isMine) return mine.state === null || isWritable(mine.state) ? 'open' : 'own_lapsed'
  return ownerActive === false ? 'owner_lapsed' : 'open'
}
