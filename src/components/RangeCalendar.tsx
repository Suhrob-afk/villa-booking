import { useMemo } from 'react'
import { addMonths, isSameDay, monthGrid, parseISODate, startOfMonth, toISODate } from '../lib/dates'
import { useI18n } from '../lib/i18n'
import { isFreeNight, lastCheckIn, type Selection, type SelectionRules } from '../lib/publicBooking'
import { haptic } from '../lib/telegram'
import { CalendarHead } from './MonthCalendar'

interface Props {
  month: Date
  onMonthChange: (month: Date) => void
  rules: SelectionRules
  /** Night -> the id of the visitor's own booking that covers it. */
  mine: Map<string, string>
  selection: Selection | null
  /** A free night: becomes check-in, one night long. */
  onPickFree: (iso: string) => void
  /** A night somebody else has. */
  onPickTaken: (iso: string) => void
  /** A night of one of the visitor's own bookings. */
  onPickMine: (bookingId: string) => void
}

/**
 * The public booking page's calendar: the same month view as MonthCalendar
 * (same header, grid and day circles), with one-tap selection instead of the
 * in-app tap-a-day-to-act behaviour.
 *
 * A guest sees four things only: free, not available, the dates they are
 * choosing, and their own bookings. Never whether somebody else's night is a
 * booking, a hold or an owner's block. Past days, and days more than a year
 * out, are inert. "Today" is the server's date in Tashkent, so a phone set to
 * another timezone still agrees with what the server will accept.
 */
export default function RangeCalendar({
  month,
  onMonthChange,
  rules,
  mine,
  selection,
  onPickFree,
  onPickTaken,
  onPickMine,
}: Props) {
  const { t } = useI18n()
  const weeks = useMemo(() => monthGrid(month), [month])

  const today = parseISODate(rules.today)
  const firstMonth = startOfMonth(today)
  const lastMonth = startOfMonth(parseISODate(lastCheckIn(rules.today)))

  const checkIn = selection?.checkIn ?? null
  const checkOut = selection?.checkOut ?? null
  const inRange = (iso: string) => checkIn !== null && checkOut !== null && iso > checkIn && iso < checkOut
  const covered = (iso: string) => iso === checkIn || iso === checkOut || inRange(iso)

  return (
    <div className="card calendar range-calendar">
      <CalendarHead
        month={month}
        onPrevMonth={month > firstMonth ? () => onMonthChange(addMonths(month, -1)) : undefined}
        onNextMonth={month < lastMonth ? () => onMonthChange(addMonths(month, 1)) : undefined}
      />

      <div className="calendar-grid">
        {weeks.map((week, weekIndex) => (
          <div className="calendar-week" key={weekIndex}>
            {week.map((date, dayIndex) => {
              const iso = toISODate(date)
              if (date.getMonth() !== month.getMonth()) {
                return <div className="day outside" key={iso} aria-hidden="true" />
              }

              const isPast = iso < rules.today
              const ownBooking = isPast ? undefined : mine.get(iso)
              const taken = !isPast && !ownBooking && rules.taken.has(iso)
              const free = !ownBooking && isFreeNight(iso, rules)
              const isStart = iso === checkIn
              const isEnd = iso === checkOut
              const selected = covered(iso)

              // Bridge a strip into one bar, within this row and month: the
              // selection, or nights of the same own booking.
              const neighbour = (offset: number) => {
                const other = week[dayIndex + offset]
                return other && other.getMonth() === month.getMonth() ? toISODate(other) : null
              }
              const linked = (offset: number) => {
                const other = neighbour(offset)
                if (!other) return false
                if (selected) return covered(other)
                return ownBooking !== undefined && mine.get(other) === ownBooking
              }
              const strip = selected ? checkIn !== null : ownBooking !== undefined

              const classes = [
                'day',
                isPast ? 'past' : ownBooking ? 'mine' : taken ? 'blocked' : free ? 'available' : '',
                isStart ? 'range-start' : '',
                isEnd ? 'range-end' : '',
                inRange(iso) ? 'in-range' : '',
                strip && !isStart && linked(-1) ? 'link-left' : '',
                strip && !isEnd && linked(1) ? 'link-right' : '',
                isSameDay(date, today) ? 'today' : '',
              ]
                .filter(Boolean)
                .join(' ')

              const label = isStart
                ? t('public.dayCheckIn', { date: iso })
                : isEnd
                  ? t('public.dayCheckOut', { date: iso })
                  : ownBooking
                    ? t('public.dayMine', { date: iso })
                    : isPast
                      ? t('calendar.dayUnavailable', { date: iso })
                      : taken
                        ? t('public.dayTaken', { date: iso })
                        : t('calendar.dayAvailable', { date: iso })

              const tappable = Boolean(ownBooking) || taken || free

              return (
                <button
                  type="button"
                  key={iso}
                  className={classes}
                  disabled={!tappable}
                  aria-label={label}
                  aria-pressed={selected}
                  onClick={() => {
                    haptic('light')
                    if (ownBooking) onPickMine(ownBooking)
                    else if (taken) onPickTaken(iso)
                    else onPickFree(iso)
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
          <span className="legend-dot blocked" /> {t('public.legendTaken')}
        </span>
        <span className="legend-item">
          <span className="legend-dot selected" /> {t('public.legendSelected')}
        </span>
        <span className="legend-item">
          <span className="legend-dot mine" /> {t('public.legendMine')}
        </span>
      </div>
    </div>
  )
}
