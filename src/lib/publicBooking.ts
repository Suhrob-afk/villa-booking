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
import type { ClientType } from './types'

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
  /**
   * The owner's subscription has lapsed (0024): no new bookings, while every
   * existing one carries on. accepting_bookings is false too.
   */
  bookings_paused: boolean
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
  guests_count: number | null
  marked_paid: boolean
  /** The owner said Not received; the visitor may pay and tap "sent" again. */
  not_received: boolean
  /** Null unless the hold is live. Display only: the countdown runs off seconds_left. */
  hold_expires_at: string | null
  /** As of the response. Null unless pending. */
  seconds_left: number | null
  /** Only while the hold is live and not yet marked paid. */
  card_number: string | null
  owner_name: string
}

export interface PublicVillaData {
  villa: PublicVilla
  /** Nights taken by other people -- never which kind, never whose. */
  unavailable: DateRange[]
  /** Today in Tashkent, from the server -- the authority on what is past. */
  today: string
  visitor: {
    registered: boolean
    has_phone: boolean
    /** The visitor's own number, shown back to them as saved. */
    phone: string | null
    /** Pre-fills the booking form. */
    name: string
  }
  /** The visitor's own bookings on this villa that are still worth showing. */
  my_bookings: PublicHold[]
  /** The one the status line is about. */
  latest_id: string | null
}

/** What the booking form sends with the dates. */
export interface BookingDetails {
  client_name: string
  guests: number
  client_type: ClientType
  note: string
}

export type PublicErrorCode =
  | 'bad_request'
  | 'unauthorized'
  | 'not_found'
  | 'not_registered'
  | 'not_accepting'
  | 'bookings_paused'
  | 'phone_required'
  | 'invalid_dates'
  | 'too_many_holds'
  | 'dates_taken'
  | 'hold_not_live'
  | 'invalid_details'
  | 'too_many_guests'
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

export async function createPublicBooking(
  villaCode: string,
  checkIn: string,
  checkOut: string,
  details: BookingDetails,
): Promise<PublicHold> {
  assertOnline()
  const { hold } = await call<{ hold: PublicHold }>('create-public-booking', {
    villa_code: villaCode,
    check_in: checkIn,
    check_out: checkOut,
    client_name: details.client_name.trim(),
    guests: details.guests,
    client_type: details.client_type,
    note: details.note.trim() || null,
  })
  return hold
}

export async function markDepositSent(bookingId: string): Promise<PublicHold> {
  assertOnline()
  const { hold } = await call<{ hold: PublicHold }>('mark-deposit-sent', { booking_id: bookingId })
  return hold
}

// ---------------------------------------------------------- date selection --

/** Mirrors create_public_hold() in migrations 0018 and 0021. */
export const MAX_NIGHTS = 60
export const MAX_DAYS_AHEAD = 365
/** Guests allowed when the owner has not set a capacity. */
export const DEFAULT_GUEST_CAP = 30
export const NAME_MIN = 2
export const NAME_MAX = 80
export const NOTE_MAX = 300

export function guestCap(capacity: number | null): number {
  return capacity ?? DEFAULT_GUEST_CAP
}

/** Check-out is always after check-in: a selection is at least one night. */
export interface Selection {
  checkIn: string
  checkOut: string
}

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
  /** Every night nobody new can book: other people's AND the visitor's own. */
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

const nextDay = (iso: string) => toISODate(addDays(parseISODate(iso), 1))

/** One tap: check-in on that night, one night long. */
export function selectNight(iso: string): Selection {
  return { checkIn: iso, checkOut: nextDay(iso) }
}

/**
 * The most nights a stay from `checkIn` can have: up to the first taken night
 * after it (half-open, so that night's date is itself a valid check-out), or
 * MAX_NIGHTS, whichever comes first.
 */
export function maxNightsFrom(checkIn: string, rules: SelectionRules): number {
  let day = checkIn
  for (let n = 1; n < MAX_NIGHTS; n++) {
    day = nextDay(day)
    if (rules.taken.has(day)) return n
  }
  return MAX_NIGHTS
}

/** The same stay with `nights` nights, never below one or past the limit. */
export function withNights(selection: Selection, nights: number, rules: SelectionRules): Selection {
  const clamped = Math.max(1, Math.min(nights, maxNightsFrom(selection.checkIn, rules)))
  return { checkIn: selection.checkIn, checkOut: toISODate(addDays(parseISODate(selection.checkIn), clamped)) }
}

/**
 * The furthest check-out a stay from `checkIn` may have: the first taken
 * night after it -- half-open, so a stay may end the day another begins --
 * or MAX_NIGHTS on, whichever comes first.
 */
export function latestCheckOut(checkIn: string, rules: SelectionRules): string {
  return toISODate(addDays(parseISODate(checkIn), maxNightsFrom(checkIn, rules)))
}

const previousDay = (iso: string) => toISODate(addDays(parseISODate(iso), -1))

/**
 * The earliest check-in a stay ending on `checkOut` may have: walking back
 * night by night while each night is free (not taken, not past, within the
 * booking window), for at most MAX_NIGHTS. The mirror of latestCheckOut().
 */
export function earliestCheckIn(checkOut: string, rules: SelectionRules): string {
  let earliest = checkOut
  for (let n = 1; n <= MAX_NIGHTS; n++) {
    const night = previousDay(earliest)
    if (!isFreeNight(night, rules)) break
    earliest = night
  }
  return earliest
}

/** A stay, and whether the pointer is beyond what can be booked (for a haptic tick). */
export interface Clamped {
  selection: Selection
  clamped: boolean
}

/**
 * Check-in fixed, check-out following the pointer: never less than one night,
 * never past latestCheckOut() -- which may itself be a taken date, the
 * half-open check-out on someone else's check-in day.
 */
export function moveCheckOut(checkIn: string, pointer: string, rules: SelectionRules): Clamped {
  const earliest = nextDay(checkIn)
  const latest = latestCheckOut(checkIn, rules)
  if (pointer > latest) return { selection: { checkIn, checkOut: latest }, clamped: true }
  return { selection: { checkIn, checkOut: pointer < earliest ? earliest : pointer }, clamped: false }
}

/**
 * Check-out fixed, check-in following the pointer: never less than one night,
 * never earlier than earliestCheckIn().
 */
export function moveCheckIn(checkOut: string, pointer: string, rules: SelectionRules): Clamped {
  const latest = previousDay(checkOut)
  const earliest = earliestCheckIn(checkOut, rules)
  if (pointer < earliest) return { selection: { checkIn: earliest, checkOut }, clamped: true }
  return { selection: { checkIn: pointer > latest ? latest : pointer, checkOut }, clamped: false }
}

/**
 * A new selection pressed on the free night `anchor` and dragged to `pointer`.
 * The two dates touched are the stay's two ends: forwards, the anchor is the
 * check-in and the pointer the check-out; backwards, the other way round.
 * Released on the anchor itself, it is one night.
 */
export function stretchFrom(anchor: string, pointer: string, rules: SelectionRules): Clamped {
  if (pointer > anchor) return moveCheckOut(anchor, pointer, rules)
  if (pointer < anchor) {
    // Backwards from a night whose eve is taken: there is no earlier check-in.
    if (earliestCheckIn(anchor, rules) === anchor) return { selection: selectNight(anchor), clamped: true }
    return moveCheckIn(anchor, pointer, rules)
  }
  return { selection: selectNight(anchor), clamped: false }
}
