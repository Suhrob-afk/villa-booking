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

// ------------------------------------------------------ amount entry ----

/**
 * What a money input actually stores: digits and at most one decimal point.
 * Separators the user sees (or pastes) are stripped back out here, so the
 * value handed to the form is always a plain number string.
 */
export function toPlainAmount(input: string): string {
  const cleaned = input.replace(/[^\d.]/g, '')
  const [whole, ...rest] = cleaned.split('.')
  return rest.length ? `${whole}.${rest.join('').slice(0, 2)}` : whole
}

/**
 * "1000000" -> "1,000,000", for display only. A trailing "." and a partly
 * typed decimal are preserved so grouping never fights the person typing.
 */
export function groupAmount(plain: string): string {
  if (!plain) return ''
  const [whole, decimals] = plain.split('.')
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  if (decimals === undefined) return plain.endsWith('.') ? `${grouped}.` : grouped
  return `${grouped}.${decimals}`
}

/** Five round amounts, scaled to the currency the field is priced in. */
export function amountSuggestions(currency: string): number[] {
  return currency.toUpperCase() === 'USD'
    ? [50, 100, 150, 200, 500]
    : [500_000, 1_000_000, 1_500_000, 2_000_000, 5_000_000]
}

/** Deposits are UZS and may never go under MIN_DEPOSIT, so they start there. */
export const DEPOSIT_SUGGESTIONS = [MIN_DEPOSIT, 200_000, 300_000, 500_000, 1_000_000]
