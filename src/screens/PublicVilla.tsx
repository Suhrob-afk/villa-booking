import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import RangeCalendar from '../components/RangeCalendar'
import { Alert, ErrorState, Loading, TopBar } from '../components/ui'
import { useAuth } from '../lib/auth'
import { formatDateShort, formatRange, nightCount, parseISODate, startOfMonth } from '../lib/dates'
import { DEPOSIT_CURRENCY, formatMoney } from '../lib/format'
import { formatCardNumber } from '../lib/holds'
import { useI18n } from '../lib/i18n'
import { quoteRange } from '../lib/pricing'
import {
  createPublicBooking,
  fetchPublicVilla,
  guestCap,
  isFreeNight,
  markDepositSent,
  MAX_NIGHTS,
  maxNightsFrom,
  NAME_MAX,
  NAME_MIN,
  NOTE_MAX,
  PublicBookingError,
  selectNight,
  unavailableNights,
  withNights,
  type PublicErrorCode,
  type PublicHold,
  type PublicVillaData,
  type Selection,
  type SelectionRules,
} from '../lib/publicBooking'
import type { StringKey } from '../lib/strings'
import { canRequestContact, notify, onForeground, requestContact } from '../lib/telegram'
import { CLIENT_TYPES, type ClientType } from '../lib/types'
import { useBackButton } from '../lib/useBackButton'

/** How long to wait for a shared contact to reach the bot and be saved. */
const PHONE_WAIT_MS = 60_000
const PHONE_POLL_MS = 2_000
/** How often the page re-checks while one of the visitor's holds is open. */
const HOLD_POLL_MS = 15_000

const ERROR_KEYS: Partial<Record<PublicErrorCode, StringKey>> = {
  dates_taken: 'public.errorDatesTaken',
  too_many_holds: 'public.errorTooManyHolds',
  not_accepting: 'public.notAccepting',
  invalid_dates: 'public.errorInvalidDates',
  invalid_details: 'public.errorInvalidDetails',
  too_many_guests: 'public.errorTooManyGuests',
  not_registered: 'public.errorNotRegistered',
  unauthorized: 'public.errorNotRegistered',
  phone_required: 'public.phoneTimeout',
  network: 'public.errorNetwork',
}

type PhoneIssue = 'declined' | 'timeout' | 'unsupported' | null

/**
 * Where one of the visitor's bookings stands, as the page tells it.
 *
 *   hold        live, deposit not yet marked sent: the card number is showing
 *   waiting     live, marked sent: the owner is checking
 *   lapsedPaid  marked sent, then ran out -- the owner can still "Confirm
 *               anyway" from the bot while the dates are free
 *   expired / confirmed / declined (rejected in the bot) / cancelled (in the app)
 */
type Phase = 'hold' | 'waiting' | 'lapsedPaid' | 'expired' | 'confirmed' | 'declined' | 'cancelled'

/** The server's response, plus when it arrived -- seconds_left counts down from that moment. */
interface Received {
  data: PublicVillaData
  receivedAt: number
}

function clockTime(ms: number): string {
  const date = new Date(ms)
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

function countdown(seconds: number): string {
  const s = Math.max(0, Math.ceil(seconds))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

const sleep = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms))

/**
 * The public booking page, opened from t.me/oikoz_villa_bot/open?startapp=
 * {villa_code}. Anyone with the link sees it -- owner, makler or a first-time
 * visitor registered a moment ago as a bare client.
 *
 * It is always the calendar. Above it, one status line about the visitor's
 * latest booking; on it, their own bookings in their own colour. Tapping a
 * free night selects a one-night stay that a stepper lengthens; the details
 * form and "Reserve & Pay Deposit" sit in the card under the calendar. Tapping
 * one of their own nights opens that booking's card -- the owner's card
 * number and "I've sent the deposit" live there while the hold is unpaid.
 */
export default function PublicVilla() {
  const { villaCode = '' } = useParams<{ villaCode: string }>()
  const { user } = useAuth()
  const { lang, t, tn } = useI18n()
  const navigate = useNavigate()

  const [received, setReceived] = useState<Received | null>(null)
  const [loadError, setLoadError] = useState<PublicErrorCode | null>(null)

  const [month, setMonth] = useState<Date | null>(null)
  const [selection, setSelection] = useState<Selection | null>(null)
  const [openId, setOpenId] = useState<string | null>(null)
  const [takenNotice, setTakenNotice] = useState(false)
  const [sentNotice, setSentNotice] = useState(false)
  const [showBreakdown, setShowBreakdown] = useState(false)

  // The form. A null name means "not edited yet": show the pre-filled one.
  const [name, setName] = useState<string | null>(null)
  const [guests, setGuests] = useState(1)
  const [clientType, setClientType] = useState<ClientType | ''>('')
  const [note, setNote] = useState('')
  const [formError, setFormError] = useState<StringKey | null>(null)

  const [busy, setBusy] = useState<'phone' | 'creating' | 'marking' | null>(null)
  const [phoneIssue, setPhoneIssue] = useState<PhoneIssue>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [now, setNow] = useState(() => Date.now())

  const bookingCardRef = useRef<HTMLDivElement | null>(null)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  // Owners and maklers checking their own link can go back to the app proper.
  const canLeave = Boolean(user?.is_owner || user?.is_makler)
  const goHome = useCallback(() => navigate('/', { replace: true }), [navigate])
  useBackButton(canLeave ? goHome : null)

  const applyData = useCallback((next: PublicVillaData) => {
    setReceived({ data: next, receivedAt: Date.now() })
    setLoadError(null)
    setMonth((current) => current ?? startOfMonth(parseISODate(next.today)))
    setNow(Date.now())
  }, [])

  const load = useCallback(
    async (quiet = false) => {
      try {
        const next = await fetchPublicVilla(villaCode)
        if (!mounted.current) return null
        applyData(next)
        return next
      } catch (err) {
        if (!mounted.current) return null
        // A background refresh that fails leaves the page as it was.
        if (!quiet) setLoadError(err instanceof PublicBookingError ? err.code : 'server')
        return null
      }
    },
    [applyData, villaCode],
  )

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => onForeground(() => void load(true)), [load])

  const data = received?.data ?? null

  const secondsLeft = useCallback(
    (booking: PublicHold) =>
      received && booking.seconds_left !== null ? booking.seconds_left - (now - received.receivedAt) / 1000 : null,
    [received, now],
  )

  const phaseOf = useCallback(
    (booking: PublicHold): Phase => {
      switch (booking.status) {
        case 'pending':
        case 'expired': {
          const left = booking.status === 'pending' ? secondsLeft(booking) : null
          if (left !== null && left > 0) return booking.marked_paid ? 'waiting' : 'hold'
          // "Confirm anyway" is refused once check-in has passed (0020).
          return booking.marked_paid && data && booking.check_in >= data.today ? 'lapsedPaid' : 'expired'
        }
        case 'confirmed':
          return 'confirmed'
        case 'rejected':
          return 'declined'
        case 'cancelled':
          return 'cancelled'
      }
    },
    [secondsLeft, data],
  )

  const bookings = useMemo(() => data?.my_bookings ?? [], [data])
  const latest = bookings.find((b) => b.id === data?.latest_id) ?? null
  const opened = bookings.find((b) => b.id === openId) ?? null

  /** Nights of the visitor's live holds and confirmed stays -> booking id. */
  const mine = useMemo(() => {
    const nights = new Map<string, string>()
    for (const booking of bookings) {
      const phase = phaseOf(booking)
      if (phase !== 'hold' && phase !== 'waiting' && phase !== 'confirmed') continue
      for (const night of unavailableNights([{ start: booking.check_in, end: booking.check_out }])) {
        nights.set(night, booking.id)
      }
    }
    return nights
  }, [bookings, phaseOf])

  const rules: SelectionRules | null = useMemo(() => {
    if (!data) return null
    const taken = unavailableNights(data.unavailable)
    for (const night of mine.keys()) taken.add(night)
    return { today: data.today, taken }
  }, [data, mine])

  // Re-check while a hold is open, so the page notices the owner confirming,
  // rejecting, or the hold running out; and while a paid hold has lapsed,
  // because the owner can still confirm it. The tick moves the countdowns.
  const watching = bookings.some((b) => {
    const phase = phaseOf(b)
    return phase === 'hold' || phase === 'waiting' || phase === 'lapsedPaid'
  })
  useEffect(() => {
    if (!watching) return
    const tick = window.setInterval(() => setNow(Date.now()), 1000)
    const poll = window.setInterval(() => void load(true), HOLD_POLL_MS)
    return () => {
      window.clearInterval(tick)
      window.clearInterval(poll)
    }
  }, [watching, load])

  // Availability can change under a selection (another guest, a refresh).
  // Keep what still fits, shorten what no longer does, drop the rest.
  useEffect(() => {
    if (!rules || !selection) return
    if (!isFreeNight(selection.checkIn, rules)) {
      setSelection(null)
      return
    }
    const nights = nightCount(selection.checkIn, selection.checkOut)
    if (nights > maxNightsFrom(selection.checkIn, rules)) setSelection(withNights(selection, nights, rules))
  }, [rules, selection])

  // The booking card opens under the calendar, out of sight on a phone.
  useEffect(() => {
    if (openId) bookingCardRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }, [openId])

  const cap = data ? guestCap(data.villa.capacity) : 1
  useEffect(() => {
    setGuests((current) => Math.min(current, cap))
  }, [cap])

  /**
   * Folds one booking from a create / mark response into the last full
   * response. Every other booking's countdown is re-based to now, because
   * receivedAt moves with it.
   */
  function mergeBooking(booking: PublicHold) {
    setReceived((current) => {
      if (!current) return current
      const at = Date.now()
      const rebased = current.data.my_bookings
        .filter((b) => b.id !== booking.id)
        .map((b) =>
          b.seconds_left === null ? b : { ...b, seconds_left: b.seconds_left - (at - current.receivedAt) / 1000 },
        )
      return {
        data: { ...current.data, my_bookings: [booking, ...rebased], latest_id: booking.id },
        receivedAt: at,
      }
    })
    setNow(Date.now())
  }

  function clearMessages() {
    setTakenNotice(false)
    setSentNotice(false)
    setActionError(null)
    setPhoneIssue(null)
    setFormError(null)
  }

  // ------------------------------------------------------------- actions --

  async function waitForPhone(): Promise<boolean> {
    const deadline = Date.now() + PHONE_WAIT_MS
    while (Date.now() < deadline) {
      await sleep(PHONE_POLL_MS)
      if (!mounted.current) return false
      const next = await load(true)
      if (next?.visitor.has_phone) return true
    }
    return false
  }

  /**
   * Asks Telegram for the visitor's contact unless one is on file. On success
   * busy is left as 'phone' for the caller to move on from.
   */
  async function ensurePhone(): Promise<boolean> {
    if (data?.visitor.has_phone) return true
    setPhoneIssue(null)
    if (!canRequestContact()) {
      setPhoneIssue('unsupported')
      return false
    }
    setBusy('phone')
    const shared = await requestContact()
    if (!shared) {
      setBusy(null)
      setPhoneIssue('declined')
      return false
    }
    if (!(await waitForPhone())) {
      if (mounted.current) {
        setBusy(null)
        setPhoneIssue('timeout')
      }
      return false
    }
    return true
  }

  async function sharePhone() {
    if (busy) return
    if ((await ensurePhone()) && mounted.current) setBusy(null)
  }

  const visitorName = (name ?? data?.visitor.name ?? '').trim()

  async function reserve() {
    if (!data || !selection || busy) return
    setActionError(null)

    if (visitorName.length < NAME_MIN || visitorName.length > NAME_MAX) {
      setFormError('public.nameInvalid')
      return
    }
    if (!clientType) {
      setFormError('public.clientTypeMissing')
      return
    }
    setFormError(null)

    if (!(await ensurePhone()) || !mounted.current) return

    setBusy('creating')
    try {
      const created = await createPublicBooking(villaCode, selection.checkIn, selection.checkOut, {
        client_name: visitorName,
        guests,
        client_type: clientType,
        note,
      })
      if (!mounted.current) return
      notify('success')
      mergeBooking(created)
      setSelection(null)
      setOpenId(created.id)
      setNote('')
      void load(true)
    } catch (err) {
      if (!mounted.current) return
      notify('error')
      const code = err instanceof PublicBookingError ? err.code : null
      if (code === 'dates_taken') {
        setSelection(null)
        void load(true)
      }
      if (code === 'phone_required') setPhoneIssue('timeout')
      else
        setActionError(
          code && ERROR_KEYS[code] ? t(ERROR_KEYS[code]!, { max: cap }) : (err as Error).message || t('public.errorGeneric'),
        )
    } finally {
      if (mounted.current) setBusy(null)
    }
  }

  async function markSent(booking: PublicHold) {
    if (busy) return
    setActionError(null)
    setBusy('marking')
    try {
      const updated = await markDepositSent(booking.id)
      if (!mounted.current) return
      notify('success')
      mergeBooking(updated)
      setOpenId(null)
      setSentNotice(true)
      // Back up to the status line and the notice, above the calendar.
      window.scrollTo({ top: 0, behavior: 'smooth' })
    } catch (err) {
      if (!mounted.current) return
      if (err instanceof PublicBookingError && err.hold) {
        mergeBooking(err.hold)
      } else {
        notify('error')
        const code = err instanceof PublicBookingError ? err.code : null
        setActionError(code && ERROR_KEYS[code] ? t(ERROR_KEYS[code]!) : (err as Error).message || t('public.errorGeneric'))
      }
    } finally {
      if (mounted.current) setBusy(null)
    }
  }

  /**
   * The Clipboard API is missing or refused in some Telegram WebViews; the
   * number is also user-select: all, so a long-press copies it regardless.
   */
  async function copyCard(card: string) {
    try {
      await navigator.clipboard.writeText(card)
      notify('success')
      setCopied(true)
      window.setTimeout(() => setCopied(false), 2000)
    } catch {
      // Left for a manual long-press copy.
    }
  }

  function openBooking(id: string) {
    clearMessages()
    setSelection(null)
    setOpenId(id)
  }

  // --------------------------------------------------------------- views --

  if (loadError === 'not_found') {
    return (
      <Page>
        <div className="center-state">
          <h2>{t('public.notFoundTitle')}</h2>
          <p>{t('public.notFoundBody')}</p>
        </div>
      </Page>
    )
  }
  if (loadError) {
    return (
      <Page>
        <ErrorState message={t(ERROR_KEYS[loadError] ?? 'public.errorGeneric')} onRetry={() => void load()} />
      </Page>
    )
  }
  if (!data || !rules || !month || !received) return <Loading />

  const { villa } = data
  const header = (
    <TopBar
      title={villa.name}
      subtitle={[villa.location, villa.capacity ? tn('guests', villa.capacity) : null].filter(Boolean).join(' · ')}
      onBack={canLeave ? goHome : undefined}
    />
  )

  /** "held until" on the phone's own clock, from the server's countdown. */
  const heldUntil = (booking: PublicHold) => clockTime(received.receivedAt + (booking.seconds_left ?? 0) * 1000)

  function statusText(booking: PublicHold): string {
    switch (phaseOf(booking)) {
      case 'hold':
        return t('public.statusHold', { time: heldUntil(booking) })
      case 'waiting':
        return t('public.statusWaiting', { time: heldUntil(booking) })
      case 'lapsedPaid':
        return t('public.statusLapsedPaid')
      case 'expired':
        return t('public.statusExpired')
      case 'confirmed':
        return t('public.statusConfirmed')
      case 'declined':
        return t('public.statusDeclined')
      case 'cancelled':
        return t('public.statusCancelled')
    }
  }

  function tone(booking: PublicHold): string {
    const phase = phaseOf(booking)
    if (phase === 'confirmed') return 'tone-mine'
    if (phase === 'hold' || phase === 'waiting' || phase === 'lapsedPaid') return 'tone-wait'
    return 'tone-off'
  }

  // ---- the selection's summary card and booking form ----
  let selectionCard: ReactNode = null
  if (selection) {
    const nights = nightCount(selection.checkIn, selection.checkOut)
    const maxNights = maxNightsFrom(selection.checkIn, rules)
    const quote = quoteRange(villa, selection.checkIn, selection.checkOut)
    const phoneMessage: Record<Exclude<PhoneIssue, null>, StringKey> = {
      declined: 'public.phoneDeclined',
      timeout: 'public.phoneTimeout',
      unsupported: 'public.phoneUnsupported',
    }

    selectionCard = (
      <div className="card card-pad" style={{ marginTop: 12 }}>
        <p className="public-section-title">
          {t('public.checkInOn', { date: formatDateShort(selection.checkIn, lang) })} ·{' '}
          {t('public.checkOutOn', { date: formatDateShort(selection.checkOut, lang) })} · {tn('nights', nights)}
        </p>

        <div className="stepper">
          <span className="stepper-label">{t('public.nightsLabel')}</span>
          <div className="stepper-controls">
            <button
              type="button"
              className="icon-button"
              aria-label={t('public.fewerNights')}
              disabled={nights <= 1}
              onClick={() => setSelection(withNights(selection, nights - 1, rules))}
            >
              −
            </button>
            <span className="stepper-value" aria-live="polite">
              {tn('nights', nights)}
            </span>
            <button
              type="button"
              className="icon-button"
              aria-label={t('public.moreNights')}
              disabled={nights >= maxNights}
              onClick={() => setSelection(withNights(selection, nights + 1, rules))}
            >
              +
            </button>
          </div>
        </div>
        {nights >= maxNights && (
          <p className="field-hint">
            {maxNights >= MAX_NIGHTS ? t('public.errorTooLong', { max: MAX_NIGHTS }) : t('public.nextNightTaken')}
          </p>
        )}

        <dl className="summary" style={{ marginTop: 12 }}>
          {showBreakdown && quote.weekdayNights > 0 && (
            <div className="summary-row muted">
              <dt>
                {t('booking.nightsSubtotal', {
                  nights: tn('weekdayNights', quote.weekdayNights),
                  rate: formatMoney(villa.weekday_price, villa.currency),
                })}
              </dt>
              <dd>{formatMoney(quote.weekdayNights * villa.weekday_price, villa.currency)}</dd>
            </div>
          )}
          {showBreakdown && quote.weekendNights > 0 && (
            <div className="summary-row muted">
              <dt>
                {t('booking.nightsSubtotal', {
                  nights: tn('weekendNights', quote.weekendNights),
                  rate: formatMoney(villa.weekend_price, villa.currency),
                })}
              </dt>
              <dd>{formatMoney(quote.weekendNights * villa.weekend_price, villa.currency)}</dd>
            </div>
          )}
          <div className="summary-row">
            <dt>{t('public.totalLabel')}</dt>
            <dd>{formatMoney(quote.suggestedTotal, villa.currency)}</dd>
          </div>
          <div className="summary-row total">
            <dt>{t('public.depositNow')}</dt>
            <dd>{formatMoney(villa.deposit_amount, DEPOSIT_CURRENCY)}</dd>
          </div>
        </dl>
        <button
          type="button"
          className="link-button"
          aria-expanded={showBreakdown}
          onClick={() => setShowBreakdown((shown) => !shown)}
        >
          {showBreakdown ? t('public.hideDetails') : t('public.showDetails')}
        </button>
        <p className="field-hint">{t('public.depositNote')}</p>

        <div className="public-section">
          <p className="public-section-title">{t('public.detailsTitle')}</p>

          <div className="field">
            <label htmlFor="public-name">{t('public.nameLabel')}</label>
            <input
              id="public-name"
              value={name ?? data.visitor.name}
              maxLength={NAME_MAX}
              autoComplete="name"
              onChange={(e) => {
                setName(e.target.value)
                setFormError(null)
              }}
            />
          </div>

          <div className="field">
            <label>{t('public.phoneLabel')}</label>
            {data.visitor.phone ? (
              <div className="public-saved-phone">
                <span>{data.visitor.phone}</span>
                <span className="badge badge-success">{t('public.phoneSavedBadge')}</span>
              </div>
            ) : (
              <>
                <button
                  type="button"
                  className="button button-secondary"
                  disabled={busy !== null}
                  onClick={() => void sharePhone()}
                >
                  {busy === 'phone' ? t('public.phoneSharing') : t('public.sharePhone')}
                </button>
                <p className="field-hint">{t('public.phoneHint')}</p>
              </>
            )}
          </div>

          <div className="field">
            <div className="stepper">
              <span className="stepper-label">{t('public.guestsLabel')}</span>
              <div className="stepper-controls">
                <button
                  type="button"
                  className="icon-button"
                  aria-label={t('public.fewerGuests')}
                  disabled={guests <= 1}
                  onClick={() => setGuests((g) => Math.max(1, g - 1))}
                >
                  −
                </button>
                <span className="stepper-value" aria-live="polite">
                  {tn('guests', guests)}
                </span>
                <button
                  type="button"
                  className="icon-button"
                  aria-label={t('public.moreGuests')}
                  disabled={guests >= cap}
                  onClick={() => setGuests((g) => Math.min(cap, g + 1))}
                >
                  +
                </button>
              </div>
            </div>
            <p className="field-hint">{t('public.guestsMax', { max: cap })}</p>
          </div>

          <div className="field">
            <label htmlFor="public-client-type">{t('public.clientTypeLabel')}</label>
            <select
              id="public-client-type"
              value={clientType}
              onChange={(e) => {
                setClientType(e.target.value as ClientType | '')
                setFormError(null)
              }}
            >
              <option value="" disabled>
                {t('public.clientTypeChoose')}
              </option>
              {CLIENT_TYPES.map((key) => (
                <option key={key} value={key}>
                  {t(`clientType.${key}`)}
                </option>
              ))}
            </select>
          </div>

          <div className="field" style={{ marginBottom: 0 }}>
            <label htmlFor="public-note">{t('public.noteLabel')}</label>
            <textarea
              id="public-note"
              rows={3}
              value={note}
              maxLength={NOTE_MAX}
              onChange={(e) => setNote(e.target.value)}
            />
            <p className="field-hint">{t('public.noteCount', { count: note.length, max: NOTE_MAX })}</p>
          </div>
        </div>

        {formError && <Alert>{t(formError)}</Alert>}
        {busy === 'phone' && <Alert kind="info">{t('public.phoneWaiting')}</Alert>}
        {phoneIssue && <Alert>{t(phoneMessage[phoneIssue])}</Alert>}
        {actionError && <Alert>{actionError}</Alert>}

        <button
          type="button"
          className="button public-reserve"
          disabled={!villa.accepting_bookings || busy !== null}
          onClick={() => void reserve()}
        >
          {busy === 'creating' || busy === 'phone' ? t('public.reserving') : t('public.reserve')}
        </button>
      </div>
    )
  }

  // ---- one of the visitor's own bookings ----
  let bookingCard: ReactNode = null
  if (opened) {
    const phase = phaseOf(opened)
    const left = secondsLeft(opened)
    bookingCard = (
      <div className="card card-pad" style={{ marginTop: 12, scrollMarginTop: 72 }} ref={bookingCardRef}>
        <div className="public-card-head">
          <h2>{t('public.bookingTitle')}</h2>
          <button type="button" className="icon-button" aria-label={t('public.close')} onClick={() => setOpenId(null)}>
            ×
          </button>
        </div>
        <p style={{ margin: '0 0 10px', fontSize: 14 }}>{statusText(opened)}</p>
        {phase === 'hold' && left !== null && (
          <p className="public-countdown" aria-live="polite" style={{ margin: '0 0 10px' }}>
            {t('public.holdTimer', { time: countdown(left) })}
          </p>
        )}
        <dl className="summary">
          <div className="summary-row">
            <dt>{t('public.datesLabel')}</dt>
            <dd>{formatRange(opened.check_in, opened.check_out, lang)}</dd>
          </div>
          {opened.guests_count !== null && (
            <div className="summary-row">
              <dt>{t('public.guestsLabel')}</dt>
              <dd>{tn('guests', opened.guests_count)}</dd>
            </div>
          )}
          <div className="summary-row">
            <dt>{t('public.totalLabel')}</dt>
            <dd>{formatMoney(opened.total_price, opened.currency)}</dd>
          </div>
          <div className="summary-row total">
            <dt>{t('public.depositLabel')}</dt>
            <dd>{formatMoney(opened.deposit_amount, DEPOSIT_CURRENCY)}</dd>
          </div>
        </dl>

        {phase === 'hold' && opened.card_number && (
          <div className="public-section">
            <p className="public-pay-intro">
              {t('public.payInstructions', { amount: formatMoney(opened.deposit_amount, DEPOSIT_CURRENCY) })}
            </p>
            <div className="public-card">
              <span className="public-card-label">{t('public.cardLabel')}</span>
              <span className="public-card-number">{formatCardNumber(opened.card_number)}</span>
              {opened.owner_name && (
                <span className="public-card-owner">{t('public.cardOwner', { name: opened.owner_name })}</span>
              )}
              <button
                type="button"
                className="button button-secondary button-small"
                onClick={() => void copyCard(opened.card_number!)}
              >
                {copied ? t('public.copied') : t('public.copyCard')}
              </button>
            </div>
            {actionError && <Alert>{actionError}</Alert>}
            <button
              type="button"
              className="button"
              style={{ marginTop: 14 }}
              disabled={busy !== null}
              onClick={() => void markSent(opened)}
            >
              {busy === 'marking' ? t('public.marking') : t('public.markSent')}
            </button>
            <p className="field-hint">{t('public.markSentHint')}</p>
          </div>
        )}
      </div>
    )
  }

  return (
    <Page header={header}>
      <div className="card card-pad public-intro">
        {villa.owner_name && <p className="public-host">{t('public.hostedBy', { name: villa.owner_name })}</p>}
        <div className="villa-rates">
          <span className="rate">
            <span className="rate-label">{t('home.rateWeekday')}</span>
            <span className="rate-value">{formatMoney(villa.weekday_price, villa.currency)}</span>
          </span>
          <span className="rate">
            <span className="rate-label">{t('home.rateWeekend')}</span>
            <span className="rate-value">{formatMoney(villa.weekend_price, villa.currency)}</span>
          </span>
          <span className="rate">
            <span className="rate-label">{t('public.depositLabel')}</span>
            <span className="rate-value">{formatMoney(villa.deposit_amount, DEPOSIT_CURRENCY)}</span>
          </span>
        </div>
        <p className="field-hint">{t('public.perNightHint')}</p>
      </div>

      {latest && (
        <button type="button" className="public-status-line" onClick={() => openBooking(latest.id)}>
          <span className={`status-dot ${tone(latest)}`} aria-hidden="true" />
          <span className="status-text">
            {statusText(latest)}
            <span className="status-sub">{formatRange(latest.check_in, latest.check_out, lang)}</span>
          </span>
        </button>
      )}

      {sentNotice && <Alert kind="info">{t('public.requestSent')}</Alert>}
      {!villa.accepting_bookings && <Alert kind="info">{t('public.notAccepting')}</Alert>}

      <p className="public-step">{t('public.pickCheckIn')}</p>

      <RangeCalendar
        month={month}
        onMonthChange={setMonth}
        rules={rules}
        mine={mine}
        selection={selection}
        onPickFree={(iso) => {
          clearMessages()
          setOpenId(null)
          setSelection(selectNight(iso))
        }}
        onPickTaken={() => {
          clearMessages()
          setTakenNotice(true)
        }}
        onPickMine={openBooking}
      />

      {takenNotice && <Alert kind="info">{t('public.dateBooked')}</Alert>}

      {bookingCard}
      {selectionCard}
    </Page>
  )
}

/** Every state of the page ends with the same footer. */
function Page({ header, children }: { header?: ReactNode; children: ReactNode }) {
  const { t } = useI18n()
  return (
    <>
      {header}
      <main className="screen public-screen">
        {children}
        <p className="powered-by">{t('public.poweredBy')}</p>
      </main>
    </>
  )
}
