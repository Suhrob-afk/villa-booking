import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import RangeCalendar from '../components/RangeCalendar'
import { Alert, ErrorState, Loading, TopBar } from '../components/ui'
import { useAuth } from '../lib/auth'
import { addDays, formatDateShort, formatRange, nightsBetween, parseISODate, startOfMonth, toISODate } from '../lib/dates'
import { DEPOSIT_CURRENCY, formatMoney } from '../lib/format'
import { formatCardNumber } from '../lib/holds'
import { useI18n } from '../lib/i18n'
import { quoteRange } from '../lib/pricing'
import {
  createPublicBooking,
  EMPTY_SELECTION,
  fetchPublicVilla,
  markDepositSent,
  MAX_NIGHTS,
  pickDay,
  PublicBookingError,
  unavailableNights,
  type PublicErrorCode,
  type PublicHold,
  type PublicVillaData,
  type Selection,
} from '../lib/publicBooking'
import type { StringKey } from '../lib/strings'
import { canRequestContact, notify, onForeground, requestContact } from '../lib/telegram'
import { useBackButton } from '../lib/useBackButton'

/** How long to wait for a shared contact to reach the bot and be saved. */
const PHONE_WAIT_MS = 60_000
const PHONE_POLL_MS = 2_000
/** How often a page showing a live hold re-checks it. */
const HOLD_POLL_MS = 15_000

const ERROR_KEYS: Partial<Record<PublicErrorCode, StringKey>> = {
  dates_taken: 'public.errorDatesTaken',
  too_many_holds: 'public.errorTooManyHolds',
  not_accepting: 'public.notAccepting',
  invalid_dates: 'public.errorInvalidDates',
  not_registered: 'public.errorNotRegistered',
  unauthorized: 'public.errorNotRegistered',
  phone_required: 'public.phoneTimeout',
  network: 'public.errorNetwork',
}

type PhoneIssue = 'declined' | 'timeout' | 'unsupported' | null

/** A hold, plus when it arrived -- seconds_left counts down from that moment. */
interface HeldState {
  hold: PublicHold
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
 *   browse  -> pick dates, Reserve & Pay Deposit
 *              (asks for the phone first if none is on file)
 *   pay     -> the owner's card, a countdown, "I've sent the deposit"
 *   waiting -> sent; the hold is extended while the owner checks
 *   expired / confirmed / declined
 */
export default function PublicVilla() {
  const { villaCode = '' } = useParams<{ villaCode: string }>()
  const { user } = useAuth()
  const { lang, t, tn } = useI18n()
  const navigate = useNavigate()

  const [data, setData] = useState<PublicVillaData | null>(null)
  const [loadError, setLoadError] = useState<PublicErrorCode | null>(null)
  const [held, setHeld] = useState<HeldState | null>(null)
  /** A lapsed or declined hold the visitor has moved on from this session. */
  const [dismissedHoldId, setDismissedHoldId] = useState<string | null>(null)

  const [month, setMonth] = useState<Date | null>(null)
  const [selection, setSelection] = useState<Selection>(EMPTY_SELECTION)
  const [pickError, setPickError] = useState<StringKey | null>(null)

  const [busy, setBusy] = useState<'phone' | 'creating' | 'marking' | null>(null)
  const [phoneIssue, setPhoneIssue] = useState<PhoneIssue>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [now, setNow] = useState(() => Date.now())

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
    setData(next)
    setLoadError(null)
    setMonth((current) => current ?? startOfMonth(parseISODate(next.today)))
    setHeld(next.hold ? { hold: next.hold, receivedAt: Date.now() } : null)
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

  const hold = held && held.hold.id !== dismissedHoldId ? held.hold : null
  const secondsLeft =
    held && hold?.seconds_left != null ? hold.seconds_left - (now - held.receivedAt) / 1000 : null
  const holdLive = hold?.status === 'pending' && secondsLeft !== null && secondsLeft > 0

  // Tick the countdown, and re-check now and then so the page notices the
  // owner confirming, declining, or the sweep releasing the hold.
  useEffect(() => {
    if (!holdLive) return
    const tick = window.setInterval(() => setNow(Date.now()), 1000)
    const poll = window.setInterval(() => void load(true), HOLD_POLL_MS)
    return () => {
      window.clearInterval(tick)
      window.clearInterval(poll)
    }
  }, [holdLive, load])

  const rules = useMemo(
    () => (data ? { today: data.today, taken: unavailableNights(data.unavailable) } : null),
    [data],
  )

  // Availability can change under a selection (another guest, a refresh).
  // Drop a selection that now crosses a taken night rather than offer it.
  useEffect(() => {
    if (!rules || !selection.checkIn) return
    const end = selection.checkOut ?? toISODate(addDays(parseISODate(selection.checkIn), 1))
    if (nightsBetween(selection.checkIn, end).some((night) => rules.taken.has(toISODate(night)))) {
      setSelection(EMPTY_SELECTION)
    }
  }, [rules, selection])

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

  async function reserve() {
    if (!data || !selection.checkIn || !selection.checkOut || busy) return
    setActionError(null)
    setPhoneIssue(null)

    if (!data.visitor.has_phone) {
      if (!canRequestContact()) {
        setPhoneIssue('unsupported')
        return
      }
      setBusy('phone')
      const shared = await requestContact()
      if (!shared) {
        setBusy(null)
        setPhoneIssue('declined')
        return
      }
      if (!(await waitForPhone())) {
        if (!mounted.current) return
        setBusy(null)
        setPhoneIssue('timeout')
        return
      }
    }

    setBusy('creating')
    try {
      const created = await createPublicBooking(villaCode, selection.checkIn, selection.checkOut)
      if (!mounted.current) return
      notify('success')
      setHeld({ hold: created, receivedAt: Date.now() })
      setNow(Date.now())
      setSelection(EMPTY_SELECTION)
      void load(true)
    } catch (err) {
      if (!mounted.current) return
      notify('error')
      const code = err instanceof PublicBookingError ? err.code : null
      if (code === 'dates_taken') {
        setSelection(EMPTY_SELECTION)
        void load(true)
      }
      if (code === 'phone_required') setPhoneIssue('timeout')
      else setActionError(code && ERROR_KEYS[code] ? t(ERROR_KEYS[code]!) : (err as Error).message || t('public.errorGeneric'))
    } finally {
      if (mounted.current) setBusy(null)
    }
  }

  async function markSent() {
    if (!hold || busy) return
    setActionError(null)
    setBusy('marking')
    try {
      const updated = await markDepositSent(hold.id)
      if (!mounted.current) return
      notify('success')
      setHeld({ hold: updated, receivedAt: Date.now() })
      setNow(Date.now())
    } catch (err) {
      if (!mounted.current) return
      if (err instanceof PublicBookingError && err.hold) {
        setHeld({ hold: err.hold, receivedAt: Date.now() })
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

  function startOver() {
    if (hold) setDismissedHoldId(hold.id)
    setActionError(null)
    void load(true)
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
  if (!data || !rules || !month) return <Loading />

  const { villa } = data
  const header = (
    <TopBar
      title={villa.name}
      subtitle={[villa.location, villa.capacity ? tn('guests', villa.capacity) : null].filter(Boolean).join(' · ')}
      onBack={canLeave ? goHome : undefined}
    />
  )

  // ---- a hold of this visitor's, in whatever state it is in ----
  if (hold) {
    const stay = formatRange(hold.check_in, hold.check_out, lang)
    const stayCard = (
      <div className="card card-pad">
        <dl className="summary">
          <div className="summary-row">
            <dt>{t('public.datesLabel')}</dt>
            <dd>{stay}</dd>
          </div>
          <div className="summary-row">
            <dt>{t('public.totalLabel')}</dt>
            <dd>{formatMoney(hold.total_price, hold.currency)}</dd>
          </div>
          <div className="summary-row total">
            <dt>{t('public.depositLabel')}</dt>
            <dd>{formatMoney(hold.deposit_amount, DEPOSIT_CURRENCY)}</dd>
          </div>
        </dl>
      </div>
    )

    if (holdLive && !hold.marked_paid) {
      return (
        <Page header={header}>
          <div className="public-status">
            <h2>{t('public.holdTitle')}</h2>
            <p className="public-countdown" aria-live="polite">
              {t('public.holdTimer', { time: countdown(secondsLeft!) })}
            </p>
          </div>
          {stayCard}
          <div className="card card-pad public-pay">
            <p className="public-pay-intro">
              {t('public.payInstructions', { amount: formatMoney(hold.deposit_amount, DEPOSIT_CURRENCY) })}
            </p>
            {hold.card_number && (
              <div className="public-card">
                <span className="public-card-label">{t('public.cardLabel')}</span>
                <span className="public-card-number">{formatCardNumber(hold.card_number)}</span>
                {hold.owner_name && (
                  <span className="public-card-owner">{t('public.cardOwner', { name: hold.owner_name })}</span>
                )}
                <button
                  type="button"
                  className="button button-secondary button-small"
                  onClick={() => void copyCard(hold.card_number!)}
                >
                  {copied ? t('public.copied') : t('public.copyCard')}
                </button>
              </div>
            )}
            {actionError && <Alert>{actionError}</Alert>}
            <button
              type="button"
              className="button"
              style={{ marginTop: 14 }}
              disabled={busy !== null}
              onClick={() => void markSent()}
            >
              {busy === 'marking' ? t('public.marking') : t('public.markSent')}
            </button>
            <p className="field-hint">{t('public.markSentHint')}</p>
          </div>
        </Page>
      )
    }

    if (holdLive && hold.marked_paid) {
      return (
        <Page header={header}>
          <div className="public-status">
            <h2>{t('public.waitingTitle')}</h2>
            <p>{t('public.waitingBody', { time: clockTime(held!.receivedAt + hold.seconds_left! * 1000) })}</p>
          </div>
          {stayCard}
        </Page>
      )
    }

    if (hold.status === 'confirmed') {
      return (
        <Page header={header}>
          <div className="public-status">
            <h2>{t('public.confirmedTitle')}</h2>
            <p>{t('public.confirmedBody', { date: formatDateShort(hold.check_in, lang) })}</p>
          </div>
          {stayCard}
        </Page>
      )
    }

    // Expired (including a pending hold whose clock just ran out) or declined.
    const declined = hold.status === 'cancelled'
    return (
      <Page header={header}>
        <div className="public-status">
          <h2>{declined ? t('public.declinedTitle') : t('public.expiredTitle')}</h2>
          <p>{declined ? t('public.declinedBody') : t('public.expiredBody')}</p>
          <button type="button" className="button" onClick={startOver}>
            {t('public.tryAgain')}
          </button>
        </div>
      </Page>
    )
  }

  // ---- browsing: pick dates and reserve ----
  const ready = selection.checkIn !== null && selection.checkOut !== null
  const quote = ready ? quoteRange(villa, selection.checkIn!, selection.checkOut!) : null

  const phoneMessage: Record<Exclude<PhoneIssue, null>, StringKey> = {
    declined: 'public.phoneDeclined',
    timeout: 'public.phoneTimeout',
    unsupported: 'public.phoneUnsupported',
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

      {!villa.accepting_bookings && <Alert kind="info">{t('public.notAccepting')}</Alert>}

      <p className="public-step">
        {!selection.checkIn
          ? t('public.pickCheckIn')
          : !selection.checkOut
            ? t('public.pickCheckOut', { date: formatDateShort(selection.checkIn, lang) })
            : formatRange(selection.checkIn, selection.checkOut, lang)}
      </p>

      <RangeCalendar
        month={month}
        onMonthChange={setMonth}
        rules={rules}
        selection={selection}
        onPick={(iso) => {
          const result = pickDay(selection, iso, rules)
          setSelection(result.selection)
          setPickError(
            result.error === 'overlap' ? 'public.errorOverlap' : result.error === 'tooLong' ? 'public.errorTooLong' : null,
          )
          setActionError(null)
          setPhoneIssue(null)
        }}
      />

      {pickError && <Alert>{t(pickError, { max: MAX_NIGHTS })}</Alert>}

      {quote && quote.nights > 0 && (
        <div className="card card-pad" style={{ marginTop: 12 }}>
          <dl className="summary">
            {quote.weekdayNights > 0 && (
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
            {quote.weekendNights > 0 && (
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
          <p className="field-hint">{t('public.depositNote')}</p>
        </div>
      )}

      {busy === 'phone' && <Alert kind="info">{t('public.phoneWaiting')}</Alert>}
      {phoneIssue && <Alert>{t(phoneMessage[phoneIssue])}</Alert>}
      {actionError && <Alert>{actionError}</Alert>}

      <button
        type="button"
        className="button public-reserve"
        disabled={!ready || !villa.accepting_bookings || busy !== null}
        onClick={() => void reserve()}
      >
        {busy === 'creating' || busy === 'phone' ? t('public.reserving') : t('public.reserve')}
      </button>
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
