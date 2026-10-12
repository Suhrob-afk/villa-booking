import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { addMonths, isSameDay, monthGrid, parseISODate, startOfMonth, toISODate } from '../lib/dates'
import { useI18n } from '../lib/i18n'
import {
  dragTo,
  isFreeNight,
  lastCheckIn,
  latestCheckOut,
  selectNight,
  type Selection,
  type SelectionRules,
} from '../lib/publicBooking'
import { haptic, setVerticalSwipesAllowed } from '../lib/telegram'
import { CalendarHead } from './MonthCalendar'

/**
 * How long a finger has to rest on a free day before dragging selects dates
 * instead of scrolling the page. Tune after real-device testing.
 */
const HOLD_MS = 200
/**
 * Movement, in CSS pixels, that turns a press into a scroll before HOLD_MS is
 * up. Tune after real-device testing.
 */
const MOVE_CANCEL_PX = 8
/** A drag can end with a click on wherever it started; ignore clicks this soon after. */
const CLICK_SUPPRESS_MS = 400

interface Props {
  month: Date
  onMonthChange: (month: Date) => void
  rules: SelectionRules
  /** Night -> the id of the visitor's own booking that covers it. */
  mine: Map<string, string>
  selection: Selection | null
  /** A tap on any day that can be tapped. The page decides what it means (tapDay). */
  onTapDay: (iso: string) => void
  /** A press-and-hold drag ended on this stay. */
  onDragSelect: (selection: Selection) => void
}

/** A press that may become a drag. */
interface Gesture {
  pointerId: number
  pointerType: string
  startX: number
  startY: number
  /** The free day pressed: the drag's check-in. */
  anchor: string
  timer: number | null
  dragging: boolean
  /** Whether the pointer is currently beyond what can be booked. */
  clamped: boolean
}

/** The day under a point on screen, or null between days and outside the month. */
function dayAt(x: number, y: number): string | null {
  const element = document.elementFromPoint(x, y)
  return element?.closest<HTMLElement>('[data-iso]')?.dataset.iso ?? null
}

/**
 * The public booking page's calendar: the same month view as MonthCalendar
 * (same header, grid and day circles).
 *
 * A guest sees four things only: free, not available, the dates they are
 * choosing, and their own bookings. Never whether somebody else's night is a
 * booking, a hold or an owner's block. Past days, and days more than a year
 * out, are inert. "Today" is the server's date in Tashkent, so a phone set to
 * another timezone still agrees with what the server will accept.
 *
 * Choosing a stay:
 *   - tap: check-in, then check-out (the page applies tapDay())
 *   - press and hold a free day for HOLD_MS, then drag: the range follows the
 *     pointer live and the release sets check-out. It stops at the last
 *     bookable check-out with a haptic tick, and works within this month;
 *     longer stays across months are made by tapping.
 *   - with a mouse, moving to another day while the button is held starts
 *     the drag at once -- a mouse cannot scroll the page by dragging anyway.
 *
 * While dragging, page scroll is blocked (a non-passive touchmove listener:
 * React's are passive) and Telegram's swipe-to-close is switched off, then
 * back on however the drag ends.
 */
export default function RangeCalendar({ month, onMonthChange, rules, mine, selection, onTapDay, onDragSelect }: Props) {
  const { t } = useI18n()
  const weeks = useMemo(() => monthGrid(month), [month])
  const gridRef = useRef<HTMLDivElement | null>(null)
  const gesture = useRef<Gesture | null>(null)
  const suppressClickUntil = useRef(0)

  /** The stay being dragged, shown in place of `selection` until release. */
  const [preview, setPreview] = useState<Selection | null>(null)
  const previewRef = useRef<Selection | null>(null)
  const showPreview = useCallback((next: Selection | null) => {
    previewRef.current = next
    setPreview(next)
  }, [])

  // The page re-renders every second while a hold counts down, with fresh
  // callbacks each time. Reading them through refs keeps the gesture code
  // stable, so a re-render never cancels a press in progress.
  const onDragSelectRef = useRef(onDragSelect)
  onDragSelectRef.current = onDragSelect
  const rulesRef = useRef(rules)
  rulesRef.current = rules

  const today = parseISODate(rules.today)
  const firstMonth = startOfMonth(today)
  const lastMonth = startOfMonth(parseISODate(lastCheckIn(rules.today)))

  const shown = preview ?? selection
  const checkIn = shown?.checkIn ?? null
  const checkOut = shown?.checkOut ?? null
  const inRange = (iso: string) => checkIn !== null && checkOut !== null && iso > checkIn && iso < checkOut
  const covered = (iso: string) => iso === checkIn || iso === checkOut || inRange(iso)
  /** The one taken day a tap may still pick: the check-out right before someone else's stay. */
  const validCheckOut = selection ? latestCheckOut(selection.checkIn, rules) : null

  // -------------------------------------------------------------- gesture --

  /** Ends any press or drag. `commit` false throws the dragged range away. */
  const finish = useCallback(
    (commit: boolean) => {
      const current = gesture.current
      if (!current) return
      gesture.current = null
      if (current.timer !== null) window.clearTimeout(current.timer)
      if (!current.dragging) return

      setVerticalSwipesAllowed(true)
      suppressClickUntil.current = performance.now() + CLICK_SUPPRESS_MS
      try {
        gridRef.current?.releasePointerCapture(current.pointerId)
      } catch {
        // Already released, or never captured (touch).
      }
      const dragged = previewRef.current
      showPreview(null)
      if (commit && dragged) onDragSelectRef.current(dragged)
    },
    [showPreview],
  )

  const startDrag = useCallback(() => {
    const current = gesture.current
    if (!current || current.dragging) return
    current.timer = null
    current.dragging = true
    setVerticalSwipesAllowed(false)
    // A mouse leaving the grid mid-drag must still deliver its pointerup here.
    // Only once dragging: capturing earlier would retarget a plain tap's click.
    if (current.pointerType === 'mouse') {
      try {
        gridRef.current?.setPointerCapture(current.pointerId)
      } catch {
        // Not capturable; the drag still works while the pointer stays over the grid.
      }
    }
    haptic('light')
    showPreview(selectNight(current.anchor))
  }, [showPreview])

  /** Follows the pointer: the stay from the anchor to the day underneath. */
  const dragOver = useCallback(
    (x: number, y: number) => {
      const current = gesture.current
      if (!current?.dragging) return
      const iso = dayAt(x, y)
      if (!iso) return // between days, or outside this month: keep the last range
      const next = dragTo(current.anchor, iso, rulesRef.current)
      if (next.clamped && !current.clamped) haptic('light')
      current.clamped = next.clamped
      if (previewRef.current?.checkOut !== next.selection.checkOut) showPreview(next.selection)
    },
    [showPreview],
  )

  function onPointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (gesture.current || (event.pointerType === 'mouse' && event.button !== 0)) return
    const iso = (event.target as HTMLElement).closest<HTMLElement>('[data-iso]')?.dataset.iso
    // Only a free night can start a stay; own bookings and taken days just tap.
    if (!iso || mine.has(iso) || !isFreeNight(iso, rules)) return
    gesture.current = {
      pointerId: event.pointerId,
      pointerType: event.pointerType,
      startX: event.clientX,
      startY: event.clientY,
      anchor: iso,
      timer: window.setTimeout(startDrag, HOLD_MS),
      dragging: false,
      clamped: false,
    }
  }

  function onPointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const current = gesture.current
    if (!current || event.pointerId !== current.pointerId) return
    if (current.dragging) {
      dragOver(event.clientX, event.clientY)
      return
    }
    if (current.pointerType === 'mouse') {
      // A mouse that reaches another day while held is dragging.
      const iso = dayAt(event.clientX, event.clientY)
      if (iso && iso !== current.anchor) {
        startDrag()
        dragOver(event.clientX, event.clientY)
      }
      return
    }
    // Touch or pen moving before the hold is up: that is a scroll.
    if (Math.hypot(event.clientX - current.startX, event.clientY - current.startY) > MOVE_CANCEL_PX) finish(false)
  }

  function onPointerUp(event: ReactPointerEvent<HTMLDivElement>) {
    if (gesture.current?.pointerId === event.pointerId) finish(true)
  }

  function onPointerCancel(event: ReactPointerEvent<HTMLDivElement>) {
    if (gesture.current?.pointerId === event.pointerId) finish(false)
  }

  // Native listeners for what React cannot do: a non-passive touchmove that
  // may cancel the page scroll, and touchcancel.
  useEffect(() => {
    const grid = gridRef.current
    if (!grid) return
    const onTouchMove = (event: TouchEvent) => {
      if (gesture.current?.dragging && event.cancelable) event.preventDefault()
    }
    const onTouchCancel = () => finish(false)
    grid.addEventListener('touchmove', onTouchMove, { passive: false })
    grid.addEventListener('touchcancel', onTouchCancel)
    return () => {
      grid.removeEventListener('touchmove', onTouchMove)
      grid.removeEventListener('touchcancel', onTouchCancel)
    }
  }, [finish])

  // Backgrounding the app or leaving the window mid-drag ends the drag and
  // gives Telegram its swipes back; so does leaving the page. The window-level
  // pointerup / pointercancel are a backstop: a release that somehow never
  // reaches the grid must not leave a drag running, blocking the page scroll.
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') finish(false)
    }
    const onBlur = () => finish(false)
    const onWindowUp = (event: PointerEvent) => {
      if (gesture.current?.pointerId === event.pointerId) finish(event.type === 'pointerup')
    }
    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('blur', onBlur)
    window.addEventListener('pointerup', onWindowUp)
    window.addEventListener('pointercancel', onWindowUp)
    return () => {
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('blur', onBlur)
      window.removeEventListener('pointerup', onWindowUp)
      window.removeEventListener('pointercancel', onWindowUp)
      finish(false)
    }
  }, [finish])

  // ---------------------------------------------------------------- view --

  return (
    <div className={`card calendar range-calendar${preview ? ' dragging' : ''}`}>
      <CalendarHead
        month={month}
        onPrevMonth={month > firstMonth ? () => onMonthChange(addMonths(month, -1)) : undefined}
        onNextMonth={month < lastMonth ? () => onMonthChange(addMonths(month, 1)) : undefined}
      />

      <div
        className="calendar-grid"
        ref={gridRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
        // Android's long-press menu would interrupt a hold.
        onContextMenu={(event) => {
          if (gesture.current) event.preventDefault()
        }}
      >
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

              const tappable = Boolean(ownBooking) || taken || free || iso === validCheckOut

              return (
                <button
                  type="button"
                  key={iso}
                  data-iso={iso}
                  className={classes}
                  disabled={!tappable}
                  aria-label={label}
                  aria-pressed={selected}
                  onClick={() => {
                    if (performance.now() < suppressClickUntil.current) return
                    haptic('light')
                    onTapDay(iso)
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
