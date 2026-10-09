import { useMemo } from 'react'
import {
  isSameDay,
  monthGrid,
  monthLabel,
  nightsBetween,
  startOfToday,
  toISODate,
  weekdayLabels,
} from '../lib/dates'
import { isActiveHold } from '../lib/holds'
import { useI18n } from '../lib/i18n'
import { haptic } from '../lib/telegram'
import type { BlockedDate, Booking } from '../lib/types'

/**
 * What a single day is doing. Bookings win over blocks if they ever overlap --
 * the database forbids that, so it only matters as a rendering tiebreak.
 */
type DayState =
  | { kind: 'booked'; id: string; booking: Booking }
  /** A live deposit hold from the public booking page: taken, not yet sold. */
  | { kind: 'held'; id: string; booking: Booking }
  | { kind: 'blocked'; id: string; block: BlockedDate }

interface Props {
  month: Date
  bookings: Booking[]
  blocks: BlockedDate[]
  onPrevMonth: () => void
  onNextMonth: () => void
  /** Tapping a free day. Maklers start a booking, owners start a block. */
  onSelectDay?: (date: Date) => void
  /**
   * Whether an empty day that has already passed can be tapped to log a
   * booking after the fact. It still renders muted -- it is not availability
   * on offer -- but it is not inert either.
   */
  onSelectPastDay?: (date: Date) => void
  /** The free day currently showing its card, if any. */
  selectedISO?: string | null
  onSelectBooking: (booking: Booking) => void
  onSelectBlock: (block: BlockedDate) => void
}

/**
 * Calendly-style month view.
 *
 * Every day is a circle: light blue = available, dark blue = booked, amber =
 * held for a guest paying the deposit, grey = blocked by the owner. Runs of the same booking or block are bridged into one
 * solid strip. A stay covers the nights [check_in, check_out) and a block
 * covers [start_date, end_date), so in both cases the end day stays free.
 */
export default function MonthCalendar({
  month,
  bookings,
  blocks,
  onPrevMonth,
  onNextMonth,
  onSelectDay,
  onSelectPastDay,
  selectedISO,
  onSelectBooking,
  onSelectBlock,
}: Props) {
  const { lang, t } = useI18n()
  const today = startOfToday()
  const weeks = useMemo(() => monthGrid(month), [month])

  const dayStates = useMemo(() => {
    const map = new Map<string, DayState>()
    for (const block of blocks) {
      for (const day of nightsBetween(block.start_date, block.end_date)) {
        map.set(toISODate(day), { kind: 'blocked', id: block.id, block })
      }
    }
    const now = Date.now()
    for (const booking of bookings) {
      const kind = booking.status === 'confirmed' ? 'booked' : isActiveHold(booking, now) ? 'held' : null
      if (!kind) continue
      for (const night of nightsBetween(booking.check_in, booking.check_out)) {
        map.set(toISODate(night), { kind, id: booking.id, booking })
      }
    }
    return map
  }, [bookings, blocks])

  const hasHolds = useMemo(() => [...dayStates.values()].some((state) => state.kind === 'held'), [dayStates])

  return (
    <div className="card calendar">
      <div className="calendar-head">
        <span className="calendar-month">{monthLabel(month, lang)}</span>
        <div className="calendar-nav">
          <button type="button" className="icon-button" onClick={onPrevMonth} aria-label={t('calendar.prevMonth')}>
            ‹
          </button>
          <button type="button" className="icon-button" onClick={onNextMonth} aria-label={t('calendar.nextMonth')}>
            ›
          </button>
        </div>
      </div>

      <div className="calendar-weekdays">
        {weekdayLabels(lang).map((label) => (
          <span key={label}>{label.slice(0, 1)}</span>
        ))}
      </div>

      <div className="calendar-grid">
        {weeks.map((week, weekIndex) => (
          <div className="calendar-week" key={weekIndex}>
            {week.map((date, dayIndex) => {
              const iso = toISODate(date)
              const inMonth = date.getMonth() === month.getMonth()

              if (!inMonth) {
                return <div className="day outside" key={iso} aria-hidden="true" />
              }

              const state = dayStates.get(iso)
              const isPast = date < today
              const isToday = isSameDay(date, today)
              const isFree = !state && !isPast && Boolean(onSelectDay)
              /** An empty day in the past: muted, but loggable after the fact. */
              const isLoggable = !state && isPast && Boolean(onSelectPastDay)

              // Bridge to a neighbour only when it is the same booking or the
              // same block, and is itself visible in this row.
              const prev = week[dayIndex - 1]
              const next = week[dayIndex + 1]
              const linksLeft =
                Boolean(state) &&
                dayIndex > 0 &&
                prev.getMonth() === month.getMonth() &&
                dayStates.get(toISODate(prev))?.id === state!.id
              const linksRight =
                Boolean(state) &&
                dayIndex < 6 &&
                next.getMonth() === month.getMonth() &&
                dayStates.get(toISODate(next))?.id === state!.id

              const classes = [
                'day',
                state ? state.kind : isFree ? 'available' : 'past',
                isLoggable ? 'loggable' : '',
                linksLeft ? 'link-left' : '',
                linksRight ? 'link-right' : '',
                isToday ? 'today' : '',
                selectedISO === iso ? 'selected' : '',
              ]
                .filter(Boolean)
                .join(' ')

              const interactive = Boolean(state) || isFree || isLoggable

              const label = state
                ? state.kind === 'held'
                  ? t('calendar.dayHeld', { date: iso })
                  : state.kind === 'booked'
                  ? state.booking.client_name.trim()
                    ? t('calendar.dayBooked', { date: iso, name: state.booking.client_name })
                    : t('calendar.dayBookedNoName', { date: iso })
                  : t('calendar.dayBlocked', { date: iso })
                : isFree
                  ? t('calendar.dayAvailable', { date: iso })
                  : isLoggable
                    ? t('calendar.dayLoggable', { date: iso })
                    : t('calendar.dayUnavailable', { date: iso })

              return (
                <button
                  type="button"
                  key={iso}
                  className={classes}
                  disabled={!interactive}
                  aria-label={label}
                  onClick={() => {
                    if (!interactive) return
                    haptic('light')
                    if (state?.kind === 'booked' || state?.kind === 'held') onSelectBooking(state.booking)
                    else if (state?.kind === 'blocked') onSelectBlock(state.block)
                    else if (isLoggable) onSelectPastDay?.(date)
                    else onSelectDay?.(date)
                  }}
                >
                  <span className="day-circle">{date.getDate()}</span>
                </button>
              )
            })}
          </div>
        ))}
      </div>

      <div className="calendar-legend">
        <span className="legend-item">
          <span className="legend-dot available" /> {t('calendar.legendAvailable')}
        </span>
        <span className="legend-item">
          <span className="legend-dot booked" /> {t('calendar.legendBooked')}
        </span>
        {hasHolds && (
          <span className="legend-item">
            <span className="legend-dot held" /> {t('calendar.legendHeld')}
          </span>
        )}
        <span className="legend-item">
          <span className="legend-dot blocked" /> {t('calendar.legendBlocked')}
        </span>
        <span className="legend-item">
          <span className="legend-dot past" /> {t('calendar.legendPast')}
        </span>
      </div>
    </div>
  )
}
