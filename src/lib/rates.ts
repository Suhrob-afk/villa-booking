/**
 * The USD/UZS rate behind the combined totals.
 *
 * Per-currency figures are the ground truth and never depend on this; the
 * combined line is an extra that simply disappears when no rate is available.
 * Every path here resolves to null rather than throwing, so a bank outage can
 * never take a screen down or block the bookings from rendering.
 */

import { useEffect, useState } from 'react'
import { supabase } from './supabase'

export interface ExchangeRate {
  code: string
  /** UZS per 1 USD. */
  rate: number
  /** The date the bank published it for -- it can lag today by a day. */
  rateDate: string
  /** True when the bank was unreachable and this is the last rate we held. */
  stale: boolean
}

/**
 * One request per app session. The Edge Function caches per day on the server;
 * this stops each screen visit from even asking.
 */
let pending: Promise<ExchangeRate | null> | null = null

export function fetchUsdRate(): Promise<ExchangeRate | null> {
  if (!pending) {
    pending = (async () => {
      try {
        const { data, error } = await supabase.functions.invoke('exchange-rate')
        if (error || !data || typeof data.rate !== 'number' || !Number.isFinite(data.rate)) return null
        return {
          code: data.code ?? 'USD',
          rate: data.rate,
          rateDate: data.rateDate ?? '',
          stale: Boolean(data.stale),
        }
      } catch {
        return null
      }
    })().then((result) => {
      // A failure is not cached: the next screen gets another chance.
      if (!result) pending = null
      return result
    })
  }
  return pending
}

/** null until it arrives, and null forever if it cannot be had. */
export function useExchangeRate(): ExchangeRate | null {
  const [rate, setRate] = useState<ExchangeRate | null>(null)

  useEffect(() => {
    let alive = true
    void fetchUsdRate().then((result) => {
      if (alive) setRate(result)
    })
    return () => {
      alive = false
    }
  }, [])

  return rate
}

/**
 * Converts per-currency amounts into USD and adds them up. Returns null if any
 * currency has no known conversion -- a partial sum presented as a total would
 * be worse than no total at all.
 */
export function combineToUsd(entries: [string, number][], rate: ExchangeRate): number | null {
  let total = 0
  for (const [currency, amount] of entries) {
    if (currency === 'USD') total += amount
    else if (currency === 'UZS') total += amount / rate.rate
    else return null
  }
  return total
}

/** "11,783.47" -- grouped, and never more precise than the bank quoted. */
export function formatRate(rate: number): string {
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(rate)
}
