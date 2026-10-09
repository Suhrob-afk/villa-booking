import { useMemo } from 'react'
import { addMonths, isSameDay, monthGrid, parseISODate, startOfMonth, toISODate } from '../lib/dates'
import { useI18n } from '../lib/i18n'
import { isPickable, lastCheckIn, type Selection, type SelectionRules } from '../lib/publicBooking'
import { haptic } from '../lib/telegram'
import { CalendarHead } from './MonthCalendar'

interface Props {
  month: Date
  onMonthChange: (month: Date) => void
  rules: SelectionRules
  selection: Selection
  onPick: (iso: string) => void
}

/**
 * The public booking page's calendar: the same month view as MonthCalendar
 * (same header, grid and day circles), with two-tap range selection instead
 * of the in-app tap-a-day-to-act behaviour.
 *
 * A guest sees only free or taken -- never whether a night is a booking, a
 * hold or an owner's block. Past days, and days more than a year out, are
 * inert. "Today" is the server's date in Tashkent, so a phone set to another
 * timezone still agrees with what the server will accept.
 */
export default function RangeCalendar({ month, onMonthChange, rules, selection, onPick }: Props) {
  const { t } = useI18n()
  const weeks = useMemo(() => monthGrid(month), [month])

  const today = parseISODate(rules.today)
  const firstMonth = startOfMonth(today)
  const lastMonth = startOfMonth(parseISODate(lastCheckIn(rules.today)))

  const { checkIn, checkOut } = selection
  const inRange = (iso: string) =>
    checkIn !== null && checkOut !== null && iso > checkIn && iso < checkOut

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
              const taken = rules.taken.has(iso)
              const pickable = isPickable(iso, selection, rules)
              const isStart = iso === checkIn
              const isEnd = iso === checkOut
              const covered = isStart || isEnd || inRange(iso)

              // Bridge selected days into one strip, within this row and month.
              const neighbourCovered = (offset: number) => {
                const other = week[dayIndex + offset]
                if (!other || other.getMonth() !== month.getMonth()) return false
                const otherIso = toISODate(other)
                return otherIso === checkIn || otherIso === checkOut || inRange(otherIso)
              }
              const ranged = checkIn !== null && checkOut !== null && covered

              const classes = [
                'day',
                isPast ? 'past' : taken ? 'blocked' : 'available',
                pickable ? 'pickable' : '',
                isStart ? 'range-start' : '',
                isEnd ? 'range-end' : '',
                inRange(iso) ? 'in-range' : '',
                ranged && !isStart && neighbourCovered(-1) ? 'link-left' : '',
                ranged && !isEnd && neighbourCovered(1) ? 'link-right' : '',
                isSameDay(date, today) ? 'today' : '',
              ]
                .filter(Boolean)
                .join(' ')

              const label = isStart
                ? t('public.dayCheckIn', { date: iso })
                : isEnd
                  ? t('public.dayCheckOut', { date: iso })
                  : isPast
                    ? t('calendar.dayUnavailable', { date: iso })
                    : taken
                      ? t('public.dayTaken', { date: iso })
                      : t('calendar.dayAvailable', { date: iso })

              return (
                <button
                  type="button"
                  key={iso}
                  className={classes}
                  disabled={!pickable}
                  aria-label={label}
                  aria-pressed={covered}
                  onClick={() => {
                    haptic('light')
                    onPick(iso)
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
      </div>
    </div>
  )
}
