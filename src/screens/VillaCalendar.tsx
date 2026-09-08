import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import MonthCalendar from '../components/MonthCalendar'
import { createBlock, deleteBlock, fetchBlockedDates, fetchBookings, fetchVilla } from '../lib/api'
import { useAuth } from '../lib/auth'
import {
  addDays,
  addMonths,
  formatDateShort,
  formatRange,
  isWeekend,
  nightsBetween,
  parseISODate,
  startOfMonth,
  startOfToday,
  toISODate,
} from '../lib/dates'
import { bookingTitle, formatMoney } from '../lib/format'
import { useI18n } from '../lib/i18n'
import { MONTHS, WEEKDAYS_LONG } from '../lib/strings'
import { confirmAction, notify } from '../lib/telegram'
import { useBackButton } from '../lib/useBackButton'
import { BLOCK_REASONS, type BlockedDate, type BlockReason, type Booking, type Villa } from '../lib/types'
import { Empty, ErrorState, Loading, TopBar } from '../components/ui'

export default function VillaCalendar() {
  const { villaId } = useParams<{ villaId: string }>()
  const navigate = useNavigate()
  const { user } = useAuth()
  const { lang, t } = useI18n()

  const [villa, setVilla] = useState<Villa | null>(null)
  const [bookings, setBookings] = useState<Booking[]>([])
  const [blocks, setBlocks] = useState<BlockedDate[]>([])
  const [month, setMonth] = useState(() => startOfMonth(new Date()))
  /** A free day that was tapped: opens the rate card, or the block form. */
  const [selectedISO, setSelectedISO] = useState<string | null>(null)
  /** A blocked day that was tapped. */
  const [selectedBlock, setSelectedBlock] = useState<BlockedDate | null>(null)
  const [blockError, setBlockError] = useState<string | null>(null)
  /** Which branch the owner picked after tapping a free day. */
  const [ownerAction, setOwnerAction] = useState<'block' | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const goBack = useCallback(() => navigate('/'), [navigate])
  useBackButton(goBack)

  const load = useCallback(async () => {
    if (!villaId) return
    setLoading(true)
    setError(null)
    try {
      const [villaRow, bookingRows, blockRows] = await Promise.all([
        fetchVilla(villaId),
        fetchBookings(villaId),
        fetchBlockedDates(villaId),
      ])
      setVilla(villaRow)
      setBookings(bookingRows)
      setBlocks(blockRows)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setLoading(false)
    }
  }, [villaId])

  useEffect(() => {
    void load()
  }, [load])

  const isOwner = Boolean(villa && user && villa.owner_id === user.id)

  /**
   * Nights booked inside the visible month, and what they are worth. The
   * commission figure counts only the current user's own bookings — a villa
   * can have several managers, and each one is shown their own earnings.
   */
  const monthStats = useMemo(() => {
    let nights = 0
    let commission = 0
    let payout = 0
    for (const booking of bookings) {
      if (booking.status !== 'confirmed') continue
      const inMonth = nightsBetween(booking.check_in, booking.check_out).filter(
        (night) => night.getMonth() === month.getMonth() && night.getFullYear() === month.getFullYear(),
      ).length
      if (!inMonth) continue
      nights += inMonth
      payout += booking.owner_payout
      if (booking.manager_id === user?.id) commission += booking.manager_commission
    }
    return { nights, commission, payout }
  }, [bookings, month, user])

  const upcoming = useMemo(() => {
    const todayISO = toISODate(startOfToday())
    return bookings
      .filter((b) => b.status === 'confirmed' && b.check_out >= todayISO)
      .sort((a, b) => a.check_in.localeCompare(b.check_in))
      .slice(0, 8)
  }, [bookings])

  if (loading) return <Loading />
  if (error) return <ErrorState message={error} onRetry={load} />
  if (!villa || !user) return null

  return (
    <>
      <TopBar
        title={villa.name}
        subtitle={villa.location ?? undefined}
        onBack={goBack}
        action={
          isOwner ? (
            <button
              type="button"
              className="icon-button"
              onClick={() => navigate(`/villa/${villa.id}/setup`)}
              aria-label={t('villa.setupAria')}
            >
              ⚙
            </button>
          ) : undefined
        }
      />
      <main className="screen">
        <button
          type="button"
          className="stat-card-link"
          onClick={() => navigate(`/villa/${villa.id}/breakdown`)}
        >
          <span className="stat-figure">
            <span className="stat-label">{t('villa.nightsBooked')}</span>
            <span className="stat-value">{monthStats.nights}</span>
          </span>
          <span className="stat-figure">
            <span className="stat-label">{isOwner ? t('villa.yourPayout') : t('villa.yourCommission')}</span>
            <span className="stat-value">
              {formatMoney(isOwner ? monthStats.payout : monthStats.commission, villa.currency)}
            </span>
          </span>
          <span className="stat-card-chevron" aria-hidden="true">
            ›
          </span>
        </button>

        <MonthCalendar
          month={month}
          bookings={bookings}
          onPrevMonth={() => setMonth((m) => addMonths(m, -1))}
          onNextMonth={() => setMonth((m) => addMonths(m, 1))}
          blocks={blocks}
          onSelectDay={(date) => {
            setSelectedBlock(null)
            setBlockError(null)
            setOwnerAction(null)
            setSelectedISO(toISODate(date))
          }}
          onSelectPastDay={(date) => {
            // Blocking a day that is already over means nothing, so a past day
            // skips the block-vs-log choice and goes straight to the form.
            setSelectedISO(null)
            setSelectedBlock(null)
            setOwnerAction(null)
            navigate(`/villa/${villa.id}/booking/new?date=${toISODate(date)}`)
          }}
          selectedISO={selectedISO}
          onSelectBooking={(booking) => navigate(`/booking/${booking.id}`)}
          onSelectBlock={(block) => {
            setSelectedISO(null)
            setBlockError(null)
            setSelectedBlock(block)
          }}
        />

        {blockError && (
          <div className="alert alert-error" style={{ marginTop: 12 }}>
            {blockError}
          </div>
        )}

        {selectedISO && !isOwner && (
          <DayCard
            iso={selectedISO}
            villa={villa}
            onDismiss={() => setSelectedISO(null)}
            onBook={() => navigate(`/villa/${villa.id}/booking/new?date=${selectedISO}`)}
          />
        )}

        {selectedISO && isOwner && !ownerAction && (
          <div className="day-card">
            <div className="day-card-head">
              <div>
                <h4>{t('villa.notBooked')}</h4>
                <span className="day-card-date">{formatDateShort(selectedISO, lang)}</span>
              </div>
              <button
                type="button"
                className="day-card-dismiss"
                onClick={() => setSelectedISO(null)}
                aria-label={t('common.close')}
              >
                ×
              </button>
            </div>
            <div className="button-row" style={{ marginTop: 4 }}>
              <button type="button" className="button button-secondary" onClick={() => setOwnerAction('block')}>
                {t('villa.blockDates')}
              </button>
            </div>
            <div className="button-row">
              <button
                type="button"
                className="button"
                onClick={() => navigate(`/villa/${villa.id}/booking/new?date=${selectedISO}`)}
              >
                {t('villa.logBooking')}
              </button>
            </div>
          </div>
        )}

        {selectedISO && isOwner && ownerAction === 'block' && (
          <BlockForm
            startISO={selectedISO}
            onDismiss={() => {
              setSelectedISO(null)
              setOwnerAction(null)
            }}
            onSubmit={async (endISO, reason) => {
              setBlockError(null)
              try {
                await createBlock({
                  villa_id: villa.id,
                  start_date: selectedISO,
                  end_date: endISO,
                  reason,
                  created_by: user.id,
                })
                setSelectedISO(null)
                setOwnerAction(null)
                await load()
              } catch (err) {
                notify('error')
                setBlockError((err as Error).message)
              }
            }}
          />
        )}

        {selectedBlock && (
          <BlockCard
            block={selectedBlock}
            canUnblock={isOwner}
            onDismiss={() => setSelectedBlock(null)}
            onUnblock={async () => {
              if (!(await confirmAction(t('villa.unblockConfirm')))) return
              setBlockError(null)
              try {
                await deleteBlock(selectedBlock.id)
                setSelectedBlock(null)
                await load()
              } catch (err) {
                notify('error')
                setBlockError((err as Error).message)
              }
            }}
          />
        )}

        {!isOwner && (
          <div className="button-row">
            <button
              type="button"
              className="button button-secondary"
              onClick={() => navigate(`/villa/${villa.id}/booking/new`)}
            >
              {t('villa.newBooking')}
            </button>
          </div>
        )}

        <p className="section-title">{t('villa.upcoming')}</p>
        {upcoming.length === 0 ? (
          <Empty title={t('villa.nothingBookedTitle')}>
            {isOwner ? t('villa.nothingBookedOwner') : t('villa.nothingBookedMakler')}
          </Empty>
        ) : (
          <div className="list">
            {upcoming.map((booking) => (
              <button type="button" className="row" key={booking.id} onClick={() => navigate(`/booking/${booking.id}`)}>
                <div className="row-main">
                  <div className="row-title">
                    {bookingTitle(booking.client_name, t('booking.untitled'))}
                    {!booking.deposit_paid && (
                      <span className="badge badge-pending"> {t('villa.depositPending')}</span>
                    )}
                  </div>
                  <div className="row-sub">{formatRange(booking.check_in, booking.check_out, lang)}</div>
                </div>
                <div className="row-amount">
                  {formatMoney(booking.total_price, villa.currency)}
                  <div className="row-sub">
                    {isOwner
                      ? t('villa.rowPayout', { amount: formatMoney(booking.owner_payout, villa.currency) })
                      : booking.manager_id === user.id
                        ? t('villa.rowYou', { amount: formatMoney(booking.manager_commission, villa.currency) })
                        : t('villa.rowOtherMakler')}
                  </div>
                </div>
              </button>
            ))}
          </div>
        )}
      </main>
    </>
  )
}

/**
 * Shown when a makler taps a free day: what that night costs and what deposit
 * to collect, before committing to the booking form.
 */
function DayCard({
  iso,
  villa,
  onDismiss,
  onBook,
}: {
  iso: string
  villa: Villa
  onDismiss: () => void
  onBook: () => void
}) {
  const { lang, t } = useI18n()
  const date = parseISODate(iso)
  const weekend = isWeekend(date)
  const rate = weekend ? villa.weekend_price : villa.weekday_price

  return (
    <div className="day-card">
      <div className="day-card-head">
        <div>
          <h4>{t('villa.notBooked')}</h4>
          <span className="day-card-date">
            {`${WEEKDAYS_LONG[lang][(date.getDay() + 6) % 7]}, ${date.getDate()} ${MONTHS[lang][date.getMonth()]}`}
          </span>
        </div>
        <button type="button" className="day-card-dismiss" onClick={onDismiss} aria-label={t('common.close')}>
          ×
        </button>
      </div>

      <dl className="summary">
        <div className="summary-row">
          <dt>{weekend ? t('villa.weekendRate') : t('villa.weekdayRate')}</dt>
          <dd>{formatMoney(rate, villa.currency)}</dd>
        </div>
        <div className="summary-row">
          <dt>{t('villa.deposit')}</dt>
          <dd>{formatMoney(villa.deposit_amount, villa.currency)}</dd>
        </div>
      </dl>

      <div className="button-row">
        <button type="button" className="button" onClick={onBook}>
          {t('villa.bookThisDate')}
        </button>
      </div>
    </div>
  )
}

/**
 * Owner-only. Blocking runs from the tapped day up to (not including) the end
 * date, matching how a booking's checkout day stays free.
 */
function BlockForm({
  startISO,
  onDismiss,
  onSubmit,
}: {
  startISO: string
  onDismiss: () => void
  onSubmit: (endISO: string, reason: BlockReason) => Promise<void>
}) {
  const { lang, t, tn } = useI18n()
  const [endISO, setEndISO] = useState(() => toISODate(addDays(parseISODate(startISO), 1)))
  const [reason, setReason] = useState<BlockReason>('owner_use')
  const [busy, setBusy] = useState(false)

  const nights = Math.max(0, Math.round((parseISODate(endISO).getTime() - parseISODate(startISO).getTime()) / 86_400_000))

  return (
    <div className="day-card day-card-muted">
      <div className="day-card-head">
        <div>
          <h4>{t('villa.blockDates')}</h4>
          <span className="day-card-date">
            {t('villa.blockFrom', { date: formatDateShort(startISO, lang) })}
            {nights > 0 ? ` · ${tn('nights', nights)}` : ''}
          </span>
        </div>
        <button type="button" className="day-card-dismiss" onClick={onDismiss} aria-label={t('common.close')}>
          ×
        </button>
      </div>

      <div className="field">
        <label htmlFor="block-end">{t('villa.blockUntilLabel')}</label>
        <input
          id="block-end"
          type="date"
          value={endISO}
          min={toISODate(addDays(parseISODate(startISO), 1))}
          onChange={(e) => setEndISO(e.target.value)}
        />
      </div>

      <div className="field" style={{ marginBottom: 0 }}>
        <label htmlFor="block-reason">{t('villa.blockReasonLabel')}</label>
        <select id="block-reason" value={reason} onChange={(e) => setReason(e.target.value as BlockReason)}>
          {BLOCK_REASONS.map((key) => (
            <option key={key} value={key}>
              {t(`blockReason.${key}`)}
            </option>
          ))}
        </select>
      </div>

      <div className="button-row">
        <button
          type="button"
          className="button"
          disabled={busy || nights < 1}
          onClick={async () => {
            setBusy(true)
            await onSubmit(endISO, reason)
            setBusy(false)
          }}
        >
          {busy ? t('villa.blocking') : t('villa.blockSubmit')}
        </button>
      </div>
    </div>
  )
}

/** A blocked day: owners can lift it, maklers just see that it is unavailable. */
function BlockCard({
  block,
  canUnblock,
  onDismiss,
  onUnblock,
}: {
  block: BlockedDate
  canUnblock: boolean
  onDismiss: () => void
  onUnblock: () => Promise<void>
}) {
  const { lang, t } = useI18n()
  const [busy, setBusy] = useState(false)

  return (
    <div className="day-card day-card-muted">
      <div className="day-card-head">
        <div>
          <h4>{canUnblock ? t(`blockReason.${block.reason}`) : t('villa.notAvailable')}</h4>
          <span className="day-card-date">
            {formatDateShort(block.start_date, lang)} – {formatDateShort(block.end_date, lang)}
          </span>
        </div>
        <button type="button" className="day-card-dismiss" onClick={onDismiss} aria-label={t('common.close')}>
          ×
        </button>
      </div>

      {canUnblock ? (
        <div className="button-row" style={{ marginTop: 4 }}>
          <button
            type="button"
            className="button button-danger"
            disabled={busy}
            onClick={async () => {
              setBusy(true)
              await onUnblock()
              setBusy(false)
            }}
          >
            {busy ? t('villa.unblocking') : t('villa.unblock')}
          </button>
        </div>
      ) : (
        <p className="field-hint" style={{ margin: 0 }}>
          {t('villa.closedByOwner')}
        </p>
      )}
    </div>
  )
}
