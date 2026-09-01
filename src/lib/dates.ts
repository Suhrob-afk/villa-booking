/**
 * Calendar dates are handled as local-midnight Date objects and 'YYYY-MM-DD'
 * strings. Nothing here ever touches UTC conversion, so a booking never slips
 * a day for users east or west of the server.
 *
 * Anything that produces text a person reads takes the language explicitly —
 * month and weekday names live in lib/strings.ts with the rest of the copy.
 */

import { MONTHS_SHORT, MONTHS_STANDALONE, WEEKDAYS, plural } from './strings'
import type { Lang } from './types'

export function weekdayLabels(lang: Lang): string[] {
  return WEEKDAYS[lang]
}

export function toISODate(date: Date): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

export function parseISODate(iso: string): Date {
  const [y, m, d] = iso.split('-').map(Number)
  return new Date(y, m - 1, d)
}

export function addDays(date: Date, days: number): Date {
  const next = new Date(date)
  next.setDate(next.getDate() + days)
  return next
}

export function addMonths(date: Date, months: number): Date {
  return new Date(date.getFullYear(), date.getMonth() + months, 1)
}

export function startOfMonth(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), 1)
}

export function startOfToday(): Date {
  const now = new Date()
  return new Date(now.getFullYear(), now.getMonth(), now.getDate())
}

export function isSameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
}

/** Weekend = Saturday and Sunday. Weekday = Monday-Friday. */
export function isWeekend(date: Date): boolean {
  const day = date.getDay()
  return day === 0 || day === 6
}

export function monthLabel(date: Date, lang: Lang): string {
  return `${MONTHS_STANDALONE[lang][date.getMonth()]} ${date.getFullYear()}`
}

/**
 * Monday-first weeks covering the month. Leading/trailing days from the
 * neighbouring months are kept so columns line up, but a week made up
 * entirely of them is dropped rather than rendered as a blank row.
 */
export function monthGrid(month: Date): Date[][] {
  const first = startOfMonth(month)
  const offset = (first.getDay() + 6) % 7 // Monday = 0
  const gridStart = addDays(first, -offset)
  const weeks: Date[][] = []
  for (let w = 0; w < 6; w++) {
    const week = Array.from({ length: 7 }, (_, d) => addDays(gridStart, w * 7 + d))
    if (week.some((date) => date.getMonth() === month.getMonth())) weeks.push(week)
  }
  return weeks
}

/**
 * The nights a stay occupies: check-in night through the night before
 * check-out. The checkout day itself stays free for the next guest.
 */
export function nightsBetween(checkInISO: string, checkOutISO: string): Date[] {
  const start = parseISODate(checkInISO)
  const end = parseISODate(checkOutISO)
  const nights: Date[] = []
  for (let d = start; d < end; d = addDays(d, 1)) nights.push(d)
  return nights
}

export function nightCount(checkInISO: string, checkOutISO: string): number {
  if (!checkInISO || !checkOutISO) return 0
  const ms = parseISODate(checkOutISO).getTime() - parseISODate(checkInISO).getTime()
  return Math.max(0, Math.round(ms / 86_400_000))
}

export function formatDateShort(iso: string, lang: Lang): string {
  const d = parseISODate(iso)
  return `${d.getDate()} ${MONTHS_SHORT[lang][d.getMonth()]}`
}

export function formatRange(checkIn: string, checkOut: string, lang: Lang): string {
  const nights = nightCount(checkIn, checkOut)
  return `${formatDateShort(checkIn, lang)} – ${formatDateShort(checkOut, lang)} · ${plural(lang, 'nights', nights)}`
}

// ------------------------------------------------------------- periods ----

export type PeriodUnit = 'week' | 'month' | 'year'

/** Monday-first, matching the calendar grid. */
export function startOfWeek(date: Date): Date {
  const day = new Date(date.getFullYear(), date.getMonth(), date.getDate())
  return addDays(day, -((day.getDay() + 6) % 7))
}

/** Half-open [start, end): the same convention bookings and blocks use. */
export function periodRange(anchor: Date, unit: PeriodUnit): { start: Date; end: Date } {
  if (unit === 'week') {
    const start = startOfWeek(anchor)
    return { start, end: addDays(start, 7) }
  }
  if (unit === 'month') {
    const start = startOfMonth(anchor)
    return { start, end: addMonths(start, 1) }
  }
  const start = new Date(anchor.getFullYear(), 0, 1)
  return { start, end: new Date(anchor.getFullYear() + 1, 0, 1) }
}

export function shiftPeriod(anchor: Date, unit: PeriodUnit, delta: number): Date {
  if (unit === 'week') return addDays(anchor, 7 * delta)
  if (unit === 'month') return addMonths(anchor, delta)
  return new Date(anchor.getFullYear() + delta, 0, 1)
}

export function periodLabel(anchor: Date, unit: PeriodUnit, lang: Lang): string {
  const { start, end } = periodRange(anchor, unit)
  if (unit === 'year') return String(start.getFullYear())
  if (unit === 'month') return monthLabel(start, lang)
  const last = addDays(end, -1)
  return `${formatDateShort(toISODate(start), lang)} – ${formatDateShort(toISODate(last), lang)}, ${last.getFullYear()}`
}

/** True when an ISO date falls inside the half-open period. */
export function isWithin(iso: string, range: { start: Date; end: Date }): boolean {
  const date = parseISODate(iso)
  return date >= range.start && date < range.end
}
