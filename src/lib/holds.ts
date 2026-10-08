import type { Booking } from './types'

/**
 * A deposit hold that still reserves its nights. An expired hold can linger as
 * 'pending' for up to two minutes until the database sweeps it (see migration
 * 0015), so the status alone is not enough -- the expiry decides.
 */
export function isActiveHold(booking: Booking, now = Date.now()): boolean {
  return (
    booking.status === 'pending' &&
    booking.hold_expires_at !== null &&
    Date.parse(booking.hold_expires_at) > now
  )
}

/** Whether a booking occupies its nights on the calendar. */
export function occupiesNights(booking: Booking, now = Date.now()): boolean {
  return booking.status === 'confirmed' || isActiveHold(booking, now)
}

/** Holds are created and resolved server-side only; the app shows them read-only. */
export function isHold(booking: Booking): boolean {
  return booking.status === 'pending' || booking.status === 'expired'
}

/** The share link an owner pastes into an Instagram bio or a channel post. */
export function bookingLink(villaCode: string): string {
  return `https://t.me/oikoz_villa_bot/open?startapp=${encodeURIComponent(villaCode)}`
}

/** 16 digits, shown in groups of four. Anything else is returned as typed. */
export function formatCardNumber(digits: string): string {
  return digits.replace(/\D/g, '').slice(0, 16).replace(/(\d{4})(?=\d)/g, '$1 ')
}
