/**
 * Calendar dates are handled as local-midnight Date objects and 'YYYY-MM-DD'
 * strings. Nothing here ever touches UTC conversion, so a booking never slips
 * a day for users east or west of the server.
 */

export const WEEKDAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
const MONTH_LABELS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
]

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

export function monthLabel(date: Date): string {
  return `${MONTH_LABELS[date.getMonth()]} ${date.getFullYear()}`
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

export function formatDateShort(iso: string): string {
  const d = parseISODate(iso)
  return `${d.getDate()} ${MONTH_LABELS[d.getMonth()].slice(0, 3)}`
}

export function formatRange(checkIn: string, checkOut: string): string {
  const nights = nightCount(checkIn, checkOut)
  return `${formatDateShort(checkIn)} – ${formatDateShort(checkOut)} · ${nights} night${nights === 1 ? '' : 's'}`
}
