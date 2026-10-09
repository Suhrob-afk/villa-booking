/**
 * The public booking page's data and rules.
 *
 * Everything here goes through the three public Edge Functions with the
 * signed Telegram initData -- never PostgREST, and never cached locally: a
 * live hold's response carries the owner's card number.
 */

import { addDays, parseISODate, toISODate } from './dates'
import { assertOnline } from './offline'
import { callEdgeFunction } from './supabase'
import { tg } from './telegram'

// ------------------------------------------------------------------ shapes --

export interface PublicVilla {
  name: string
  location: string | null
  weekday_price: number
  weekend_price: number
  /** ISO code, e.g. "UZS". Prices and a booking's total are in this. */
  currency: string
  /** Always UZS. */
  deposit_amount: number
  capacity: number | null
  owner_name: string
  /** False until the owner has entered a payout card. */
  accepting_bookings: boolean
}

/** Half-open [start, end), like bookings and blocks. */
export interface DateRange {
  start: string
  end: string
}

export interface PublicHold {
  id: string
  status: 'pending' | 'expired' | 'confirmed' | 'cancelled' | 'rejected'
  check_in: string
  check_out: string
  total_price: number
  currency: string
  deposit_amount: number
  marked_paid: boolean
  /** As of the response. Null unless pending. */
  seconds_left: number | null
  /** Only while the hold is live. */
  card_number: string | null
  owner_name: string
}

export interface PublicVillaData {
  villa: PublicVilla
  unavailable: DateRange[]
  /** Today in Tashkent, from the server -- the authority on what is past. */
  today: string
  visitor: { registered: boolean; has_phone: boolean }
  hold: PublicHold | null
}

export type PublicErrorCode =
  | 'bad_request'
  | 'unauthorized'
  | 'not_found'
  | 'not_registered'
  | 'not_accepting'
  | 'phone_required'
  | 'invalid_dates'
  | 'too_many_holds'
  | 'dates_taken'
  | 'hold_not_live'
  | 'server'
  | 'network'

export class PublicBookingError extends Error {
  constructor(
    readonly code: PublicErrorCode,
    /** Sent back with hold_not_live: the hold as it now stands. */
    readonly hold: PublicHold | null = null,
  ) {
    super(code)
  }
}

// ------------------------------------------------------------------- calls --

async function call<T>(name: string, payload: Record<string, unknown>): Promise<T> {
  const initData = tg()?.initData
  if (!initData) throw new PublicBookingError('unauthorized')

  let result: { status: number; body: T & { code?: PublicErrorCode; hold?: PublicHold } }
  try {
    result = await callEdgeFunction(name, { initData, ...payload })
  } catch {
    throw new PublicBookingError('network')
  }
  if (result.status >= 400) {
    throw new PublicBookingError(result.body.code ?? 'server', result.body.hold ?? null)
  }
  return result.body
}

export function fetchPublicVilla(villaCode: string): Promise<PublicVillaData> {
  return call<PublicVillaData>('get-public-villa', { villa_code: villaCode })
}

export async function createPublicBooking(villaCode: string, checkIn: string, checkOut: string): Promise<PublicHold> {
  assertOnline()
  const { hold } = await call<{ hold: PublicHold }>('create-public-booking', {
    villa_code: villaCode,
    check_in: checkIn,
    check_out: checkOut,
  })
  return hold
}

export async function markDepositSent(bookingId: string): Promise<PublicHold> {
  assertOnline()
  const { hold } = await call<{ hold: PublicHold }>('mark-deposit-sent', { booking_id: bookingId })
  return hold
}

// ---------------------------------------------------------- date selection --

/** Mirrors create_public_hold() in migration 0018. */
export const MAX_NIGHTS = 60
export const MAX_DAYS_AHEAD = 365

export interface Selection {
  checkIn: string | null
  checkOut: string | null
}

export const EMPTY_SELECTION: Selection = { checkIn: null, checkOut: null }

/** Every night a range covers, as YYYY-MM-DD. Local dates only -- no UTC. */
export function unavailableNights(ranges: DateRange[]): Set<string> {
  const nights = new Set<string>()
  for (const range of ranges) {
    const end = parseISODate(range.end)
    for (let d = parseISODate(range.start); d < end; d = addDays(d, 1)) nights.add(toISODate(d))
  }
  return nights
}

export interface SelectionRules {
  today: string
  taken: Set<string>
}

/** ISO dates compare correctly as strings, so no Date is needed here. */
export function lastCheckIn(today: string): string {
  return toISODate(addDays(parseISODate(today), MAX_DAYS_AHEAD))
}

/** A night a guest could start a stay on. */
export function isFreeNight(iso: string, rules: SelectionRules): boolean {
  return iso >= rules.today && iso <= lastCheckIn(rules.today) && !rules.taken.has(iso)
}

/**
 * The latest check-out a stay from `checkIn` can have: the first taken night
 * after it (half-open, so that night's date is itself a valid check-out), or
 * MAX_NIGHTS on, whichever comes first.
 */
export function latestCheckOut(checkIn: string, rules: SelectionRules): { date: string; reason: 'taken' | 'limit' } {
  let day = parseISODate(checkIn)
  for (let i = 1; i <= MAX_NIGHTS; i++) {
    day = addDays(day, 1)
    const iso = toISODate(day)
    if (rules.taken.has(iso)) return { date: iso, reason: 'taken' }
  }
  return { date: toISODate(day), reason: 'limit' }
}

export type PickResult =
  | { selection: Selection; error?: undefined }
  | { selection: Selection; error: 'overlap' | 'tooLong' }

/**
 * Two-tap range selection. The first tap is check-in; the second is
 * check-out if it lands after check-in without crossing a taken night.
 * Tapping on or before check-in starts over from that day. A complete range
 * is replaced by the next tap.
 */
export function pickDay(current: Selection, iso: string, rules: SelectionRules): PickResult {
  const choosingCheckOut = current.checkIn !== null && current.checkOut === null

  if (!choosingCheckOut || iso <= current.checkIn!) {
    return { selection: isFreeNight(iso, rules) ? { checkIn: iso, checkOut: null } : current }
  }

  const limit = latestCheckOut(current.checkIn!, rules)
  if (iso <= limit.date) return { selection: { checkIn: current.checkIn, checkOut: iso } }
  return { selection: current, error: limit.reason === 'taken' ? 'overlap' : 'tooLong' }
}

/** Whether a day can be tapped at all in the current selection state. */
export function isPickable(iso: string, current: Selection, rules: SelectionRules): boolean {
  if (isFreeNight(iso, rules)) return true
  if (current.checkIn === null || current.checkOut !== null || iso <= current.checkIn) return false
  // The taken night that ends the available run is still a valid check-out.
  return iso <= latestCheckOut(current.checkIn, rules).date
}
