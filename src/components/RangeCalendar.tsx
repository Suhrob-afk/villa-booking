import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { addMonths, isSameDay, monthGrid, parseISODate, startOfMonth, toISODate } from '../lib/dates'
import { useI18n } from '../lib/i18n'
import {
  isFreeNight,
  lastCheckIn,
  latestCheckOut,
  moveCheckIn,
  moveCheckOut,
  selectNight,
  stretchFrom,
  type Clamped,
  type Selection,
  type SelectionRules,
} from '../lib/publicBooking'
import { haptic, selectionTick, setVerticalSwipesAllowed } from '../lib/telegram'
import { CalendarHead } from './MonthCalendar'

/**
 * Movement, in CSS pixels, below which a press that is released is a tap.
 * Only tells a tap from a drag; there is no hold delay. Tune on real devices.
 */
const TAP_SLOP_PX = 5
/** Half the minimum hit area of a range handle: 44 px across. */
const HANDLE_HIT_RADIUS_PX = 22
/**
 * Holding a drag above the grid (towards the month header) or below it
 * (towards the legend) this long flips to the previous or next month, and
 * the drag carries on there. Repeats while held.
 */
const EDGE_FLIP_MS = 500

interface Props {
  month: Date
  onMonthChange: (month: Date) => void
  rules: SelectionRules
  /** Night -> the id of the visitor's own booking that covers it. */
  mine: Map<string, string>
  selection: Selection | null
  /** A tap or a drag produced this stay. */
  onSelect: (selection: Selection) => void
  /** A tap on a day that cannot start a stay: somebody else's night, or the guest's own booking. */
  onTapBlocked: (iso: string) => void
}

/**
 *   new       pressed on a free night: a fresh stay from there
 *   checkIn   dragging the check-in handle; check-out stays put
 *   checkOut  dragging the check-out handle; check-in stays put
 *   blocked   pressed on a day that cannot start a stay; only a tap means anything
 */
type Mode = 'new' | 'checkIn' | 'checkOut' | 'blocked'

interface Gesture {
  pointerId: number
  startX: number
  startY: number
  /** The day pressed. */
  startIso: string
  mode: Mode
  /** The end of the stay that does not move: check-out for 'checkIn', check-in for 'checkOut'. */
  fixed: string
  /** Moved further than TAP_SLOP_PX: no longer a tap. */
  dragging: boolean
  /** The day last under the pointer, so each change ticks once. */
  overIso: string | null
  /** Whether the pointer is beyond what can be booked. */
  clamped: boolean
  /** Held above or below the grid: which way the month flips, and when. */
  edge: 'prev' | 'next' | null
  edgeTimer: number | null
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
 * Choosing a stay -- pointer events with capture, so touch and mouse behave
 * the same, and no hold delay:
 *   - press a free night and drag: the stay runs from there to the day under
 *     the pointer, live. Released where it started, it is a tap: one night.
 *   - once a stay exists, its two ends are handles. Dragging one moves that
 *     end only; they never cross (one night at least).
 *   - pressing anything else starts a new stay, replacing the old one.
 *   - no stay runs over a taken night: it stops at the last bookable date,
 *     with a light haptic tick. A check-out may still land on the first taken
 *     day after the stay (half-open: someone else's check-in day).
 *   - the drag works within the visible month; holding it above or below the
 *     grid for EDGE_FLIP_MS flips the month and it carries on.
 *
 * touch-action: none on the grid keeps a drag there from ever scrolling the
 * page; a touch that starts outside the grid scrolls as usual. Telegram's
 * swipe-to-close is off from press to release.
 */
export default function RangeCalendar({ month, onMonthChange, rules, mine, selection, onSelect, onTapBlocked }: Props) {
  const { t } = useI18n()
  const weeks = useMemo(() => monthGrid(month), [month])
  const gridRef = useRef<HTMLDivElement | null>(null)
  const gesture = useRef<Gesture | null>(null)

  /** The stay being dragged, shown in place of `selection` until release. */
  const [preview, setPreview] = useState<Selection | null>(null)
  const previewRef = useRef<Selection | null>(null)
  const showPreview = useCallback((next: Selection | null) => {
    previewRef.current = next
    setPreview(next)
  }, [])
  /** The handle being dragged, drawn slightly larger. */
  const [activeHandle, setActiveHandle] = useState<'checkIn' | 'checkOut' | null>(null)

  const today = parseISODate(rules.today)
  const firstMonth = startOfMonth(today)
  const lastMonth = startOfMonth(parseISODate(lastCheckIn(rules.today)))

  // The page re-renders every second while a hold counts down, with fresh
  // props each time. The gesture reads them through refs, so a re-render
  // never disturbs a drag in progress.
  const live = useRef({ month, firstMonth, lastMonth, rules, selection, onMonthChange, onSelect, onTapBlocked })
  live.current = { month, firstMonth, lastMonth, rules, selection, onMonthChange, onSelect, onTapBlocked }

  const shown = preview ?? selection
  const checkIn = shown?.checkIn ?? null
  const checkOut = shown?.checkOut ?? null
  const inRange = (iso: string) => checkIn !== null && checkOut !== null && iso > checkIn && iso < checkOut
  const covered = (iso: string) => iso === checkIn || iso === checkOut || inRange(iso)
  /** A taken day that is still the check-out handle (half-open): drawn, and pressable as a handle. */
  const validCheckOut = selection ? latestCheckOut(selection.checkIn, rules) : null

  // -------------------------------------------------------------- gesture --

  /**
   * Which handle a press at (x, y) grabs: inside a handle's own day, or within
   * HANDLE_HIT_RADIUS_PX of its centre -- so it is 44 px across even on a
   * narrow screen. When both qualify (a one-night stay), the nearer wins,
   * which splits the hit areas at the midpoint.
   */
  function handleAt(x: number, y: number): 'checkIn' | 'checkOut' | null {
    const current = live.current.selection
    if (!current) return null
    let best: { handle: 'checkIn' | 'checkOut'; distance: number } | null = null
    for (const handle of ['checkIn', 'checkOut'] as const) {
      const iso = handle === 'checkIn' ? current.checkIn : current.checkOut
      const element = gridRef.current?.querySelector<HTMLElement>(`[data-iso="${iso}"]`)
      if (!element) continue // that end is in another month
      const rect = element.getBoundingClientRect()
      const distance = Math.hypot(x - (rect.left + rect.width / 2), y - (rect.top + rect.height / 2))
      const inside = x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom
      if ((inside || distance <= HANDLE_HIT_RADIUS_PX) && (!best || distance < best.distance)) {
        best = { handle, distance }
      }
    }
    return best?.handle ?? null
  }

  /** Ends the gesture. `commit` false (cancel) leaves the selection as it was. */
  const finish = useCallback(
    (commit: boolean) => {
      const current = gesture.current
      if (!current) return
      gesture.current = null
      if (current.edgeTimer !== null) window.clearTimeout(current.edgeTimer)
      try {
        gridRef.current?.releasePointerCapture(current.pointerId)
      } catch {
        // Already released.
      }
      setVerticalSwipesAllowed(true)
      setActiveHandle(null)
      const dragged = previewRef.current
      showPreview(null)
      if (!commit) return

      const { rules: rulesNow, onSelect: select, onTapBlocked: tapBlocked } = live.current
      if (current.mode === 'blocked') {
        if (!current.dragging) tapBlocked(current.startIso)
        return
      }
      if (current.dragging) {
        if (dragged) select(dragged)
        return
      }
      // A tap. On a free night, always a fresh one-night stay -- a handle
      // included. A tap on a check-out handle sitting on a taken day does nothing.
      if (isFreeNight(current.startIso, rulesNow)) select(selectNight(current.startIso))
    },
    [showPreview],
  )

  /** The stay for the pointer over `iso`, per the gesture's mode. */
  function stayFor(current: Gesture, iso: string): Clamped {
    const rulesNow = live.current.rules
    if (current.mode === 'checkIn') return moveCheckIn(current.fixed, iso, rulesNow)
    if (current.mode === 'checkOut') return moveCheckOut(current.fixed, iso, rulesNow)
    return stretchFrom(current.startIso, iso, rulesNow)
  }

  /** Flips the month while the drag is held past the grid's edge, then waits to flip again. */
  const flipMonth = useCallback(() => {
    const current = gesture.current
    if (!current?.edge) return
    const { month: shownMonth, firstMonth: first, lastMonth: last, onMonthChange: change } = live.current
    const target = addMonths(shownMonth, current.edge === 'next' ? 1 : -1)
    if (target >= first && target <= last) {
      change(target)
      selectionTick()
      current.overIso = null
    }
    current.edgeTimer = window.setTimeout(flipMonth, EDGE_FLIP_MS)
  }, [])

  function onPointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (gesture.current || (event.pointerType === 'mouse' && event.button !== 0)) return
    const { clientX: x, clientY: y } = event
    const handle = handleAt(x, y)
    const iso = dayAt(x, y)
    const current = live.current.selection

    let mode: Mode
    let startIso: string
    let fixed = ''
    if (handle && current) {
      mode = handle
      startIso = handle === 'checkIn' ? current.checkIn : current.checkOut
      fixed = handle === 'checkIn' ? current.checkOut : current.checkIn
    } else if (iso && !mine.has(iso) && isFreeNight(iso, rules)) {
      mode = 'new'
      startIso = iso
    } else if (iso && iso >= rules.today && (mine.has(iso) || rules.taken.has(iso))) {
      mode = 'blocked'
      startIso = iso
    } else {
      return // between days, a past day, or beyond the booking window: inert
    }

    gesture.current = {
      pointerId: event.pointerId,
      startX: x,
      startY: y,
      startIso,
      mode,
      fixed,
      dragging: false,
      overIso: startIso,
      clamped: false,
      edge: null,
      edgeTimer: null,
    }
    try {
      gridRef.current?.setPointerCapture(event.pointerId)
    } catch {
      // Not capturable; moves still arrive while the pointer stays over the grid.
    }
    setVerticalSwipesAllowed(false)

    if (mode === 'new') {
      // A new stay starts the moment the finger lands: one night, for now.
      showPreview(selectNight(startIso))
      selectionTick()
    } else if (mode !== 'blocked' && current) {
      showPreview(current)
      setActiveHandle(mode)
      selectionTick()
    }
  }

  function onPointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const current = gesture.current
    if (!current || event.pointerId !== current.pointerId) return
    const { clientX: x, clientY: y } = event

    if (!current.dragging) {
      if (Math.hypot(x - current.startX, y - current.startY) < TAP_SLOP_PX) return
      current.dragging = true
    }
    if (current.mode === 'blocked') return

    // Past the top or bottom of the grid: arm a month flip.
    const rect = gridRef.current?.getBoundingClientRect()
    const edge = rect ? (y > rect.bottom ? 'next' : y < rect.top ? 'prev' : null) : null
    if (edge !== current.edge) {
      if (current.edgeTimer !== null) window.clearTimeout(current.edgeTimer)
      current.edge = edge
      current.edgeTimer = edge ? window.setTimeout(flipMonth, EDGE_FLIP_MS) : null
    }

    const iso = dayAt(x, y)
    if (!iso || iso === current.overIso) return // between days, outside the month, or no change
    current.overIso = iso

    const next = stayFor(current, iso)
    if (next.clamped && !current.clamped) haptic('light')
    current.clamped = next.clamped
    const before = previewRef.current
    if (!before || before.checkIn !== next.selection.checkIn || before.checkOut !== next.selection.checkOut) {
      showPreview(next.selection)
      selectionTick()
    }
  }

  function onPointerUp(event: ReactPointerEvent<HTMLDivElement>) {
    if (gesture.current?.pointerId === event.pointerId) finish(true)
  }

  function onPointerCancel(event: ReactPointerEvent<HTMLDivElement>) {
    if (gesture.current?.pointerId === event.pointerId) finish(false)
  }

  // Backgrounding the app or leaving the window mid-gesture cancels it and
  // gives Telegram its swipes back; so does leaving the page.
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') finish(false)
    }
    const onBlur = () => finish(false)
    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('blur', onBlur)
    return () => {
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('blur', onBlur)
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
        onLostPointerCapture={(event) => {
          if (gesture.current?.pointerId === event.pointerId) finish(false)
        }}
        // A long press must not open the browser's menu over the calendar.
        onContextMenu={(event) => event.preventDefault()}
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
                isStart ? 'range-start handle' : '',
                isEnd ? 'range-end handle' : '',
                (isStart && activeHandle === 'checkIn') || (isEnd && activeHandle === 'checkOut') ? 'handle-active' : '',
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
                  // Pointers are handled on the grid above. This is the
                  // keyboard: Enter or Space on a day (detail 0) is a tap.
                  onClick={(event) => {
                    if (event.detail !== 0) return
                    if (free) onSelect(selectNight(iso))
                    else onTapBlocked(iso)
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
