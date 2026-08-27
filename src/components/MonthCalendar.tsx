import { useMemo } from 'react'
import {
  WEEKDAY_LABELS,
  isSameDay,
  monthGrid,
  monthLabel,
  nightsBetween,
  startOfToday,
  toISODate,
} from '../lib/dates'
import { haptic } from '../lib/telegram'
import type { Booking } from '../lib/types'

interface Props {
  month: Date
  bookings: Booking[]
  onPrevMonth: () => void
  onNextMonth: () => void
  /** Tapping an available (light blue) day. Not passed = owners, who cannot book. */
  onSelectDay?: (date: Date) => void
  onSelectBooking: (booking: Booking) => void
}

/**
 * Calendly-style month view.
 *
 * Every day is a circle. Light blue = available, dark blue = booked. A stay
 * covers the nights [check_in, check_out), and consecutive booked circles are
 * bridged into one solid strip. Cancelled bookings hold no days, so cancelling
 * turns the strip back to light blue on the next render.
 */
export default function MonthCalendar({
  month,
  bookings,
  onPrevMonth,
  onNextMonth,
  onSelectDay,
  onSelectBooking,
}: Props) {
  const today = startOfToday()
  const weeks = useMemo(() => monthGrid(month), [month])

  const bookedDays = useMemo(() => {
    const map = new Map<string, Booking>()
    for (const booking of bookings) {
      if (booking.status !== 'confirmed') continue
      for (const night of nightsBetween(booking.check_in, booking.check_out)) {
        map.set(toISODate(night), booking)
      }
    }
    return map
  }, [bookings])

  return (
    <div className="card calendar">
      <div className="calendar-head">
        <span className="calendar-month">{monthLabel(month)}</span>
        <div className="calendar-nav">
          <button type="button" className="icon-button" onClick={onPrevMonth} aria-label="Previous month">
            ‹
          </button>
          <button type="button" className="icon-button" onClick={onNextMonth} aria-label="Next month">
            ›
          </button>
        </div>
      </div>

      <div className="calendar-weekdays">
        {WEEKDAY_LABELS.map((label) => (
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

              const booking = bookedDays.get(iso)
              const isPast = date < today
              const isToday = isSameDay(date, today)

              // Bridge to a neighbour only when it belongs to the same stay and
              // is itself visible in this grid row.
              const prev = week[dayIndex - 1]
              const next = week[dayIndex + 1]
              const linksLeft =
                Boolean(booking) &&
                dayIndex > 0 &&
                prev.getMonth() === month.getMonth() &&
                bookedDays.get(toISODate(prev))?.id === booking!.id
              const linksRight =
                Boolean(booking) &&
                dayIndex < 6 &&
                next.getMonth() === month.getMonth() &&
                bookedDays.get(toISODate(next))?.id === booking!.id

              const canBook = Boolean(onSelectDay) && !booking && !isPast
              const classes = [
                'day',
                booking ? 'booked' : canBook ? 'available' : 'past',
                linksLeft ? 'link-left' : '',
                linksRight ? 'link-right' : '',
                isToday ? 'today' : '',
              ]
                .filter(Boolean)
                .join(' ')

              const interactive = Boolean(booking) || canBook

              return (
                <button
                  type="button"
                  key={iso}
                  className={classes}
                  disabled={!interactive}
                  aria-label={
                    booking
                      ? `${iso} — booked by ${booking.client_name}`
                      : canBook
                        ? `${iso} — available`
                        : `${iso} — unavailable`
                  }
                  onClick={() => {
                    if (!interactive) return
                    haptic('light')
                    if (booking) onSelectBooking(booking)
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
          <span className="legend-dot available" /> Available
        </span>
        <span className="legend-item">
          <span className="legend-dot booked" /> Booked
        </span>
        <span className="legend-item">
          <span className="legend-dot past" /> Past
        </span>
      </div>
    </div>
  )
}
