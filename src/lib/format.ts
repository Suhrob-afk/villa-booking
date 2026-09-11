import type { BookingCurrency } from './types'

/**
 * What a villa can be priced in. Narrowed to the two a booking can use, since
 * the villa's currency is the default every new booking starts from; the
 * database enforces the same pair (villas_currency_supported).
 */
export const CURRENCIES = ['UZS', 'USD'] as const

/** Deposits are held in UZS, whatever currency the booking's price is in. */
export const DEPOSIT_CURRENCY = 'UZS'

/** UZS. Mirrors villas_deposit_minimum and bookings_compute() in the database. */
export const MIN_DEPOSIT = 100000

/** A booking stores its currency lowercase; money formats by ISO code. */
export function currencyCode(currency: BookingCurrency): string {
  return currency.toUpperCase()
}

/** What a new booking on a villa is priced in until someone picks otherwise. */
export function defaultBookingCurrency(villaCurrency: string): BookingCurrency {
  return villaCurrency.toUpperCase() === 'USD' ? 'usd' : 'uzs'
}

const ZERO_DECIMAL = new Set(['UZS', 'KZT', 'JPY', 'KRW'])

export function formatMoney(amount: number, currency: string): string {
  const fractionDigits = ZERO_DECIMAL.has(currency) ? 0 : 2
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency,
      minimumFractionDigits: fractionDigits,
      maximumFractionDigits: fractionDigits,
    }).format(amount)
  } catch {
    return `${amount.toFixed(fractionDigits)} ${currency}`
  }
}

export function formatPercent(rate: number): string {
  return `${round(rate * 100, 2)}%`
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

/**
 * What to call a booking in a list. An owner-logged booking carries no client
 * name -- that flow drops client identity entirely -- so it falls back to a
 * plain label rather than rendering an empty row title.
 */
export function bookingTitle(clientName: string, fallback: string): string {
  return clientName.trim() || fallback
}

/**
 * Adds up money per currency. The only safe way to total bookings now that
 * one villa can take several currencies: the result is never collapsed.
 */
export function totalsByCurrency<T>(
  rows: T[],
  currencyOf: (row: T) => string,
  amountOf: (row: T) => number,
): Map<string, number> {
  const totals = new Map<string, number>()
  for (const row of rows) {
    const currency = currencyOf(row)
    totals.set(currency, (totals.get(currency) ?? 0) + amountOf(row))
  }
  return totals
}

/** "$392.00 · 1,000,000 UZS" -- each currency shown on its own, never added. */
export function formatMoneyGroups(totals: Map<string, number>, emptyCurrency: string): string {
  if (totals.size === 0) return formatMoney(0, emptyCurrency)
  return [...totals.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([currency, amount]) => formatMoney(amount, currency))
    .join(' · ')
}
