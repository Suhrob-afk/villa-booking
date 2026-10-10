import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import GearIcon from '../components/GearIcon'
import MonthCalendar from '../components/MonthCalendar'
import PencilIcon from '../components/PencilIcon'
import {
  createBlock,
  deleteBlock,
  fetchBlockedDates,
  fetchBookingClients,
  fetchBookings,
  fetchVilla,
  type BookingClient,
} from '../lib/api'
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
import { bookingTitle, currencyCode, DEPOSIT_CURRENCY, formatMoney, formatMoneyGroups } from '../lib/format'
import { useI18n } from '../lib/i18n'
import { MONTHS, WEEKDAYS_LONG } from '../lib/strings'
import { confirmAction, notify, openTelegramLink } from '../lib/telegram'
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
  /** A booked or held night that was tapped: any night of the stay opens the same card. */
  const [selectedBookingId, setSelectedBookingId] = useState<string | null>(null)
  /** Telegram name and username of each public-page guest, by booking id. */
  const [clients, setClients] = useState<Map<string, BookingClient>>(new Map())
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

    // Only the booking card's Telegram row needs this, so it never holds up
    // or breaks the calendar -- not even before migration 0022 is applied.
    fetchBookingClients(villaId)
      .then((rows) => setClients(new Map(rows.map((row) => [row.booking_id, row]))))
      .catch(() => setClients(new Map()))
  }, [villaId])

  useEffect(() => {
    void load()
  }, [load])

  const isOwner = Boolean(villa && user && villa.owner_id === user.id)
  const selectedBooking = bookings.find((b) => b.id === selectedBookingId) ?? null

  /**
   * Nights booked inside the visible month, and what they are worth. The
   * commission figure counts only the current user's own bookings — a villa
   * can have several managers, and each one is shown their own earnings.
   * Money is kept per currency: one villa can take UZS and USD bookings in the
   * same month, and those two figures must never be added together.
   */
  const monthStats = useMemo(() => {
    let nights = 0
    const commission = new Map<string, number>()
    const payout = new Map<string, number>()
    for (const booking of bookings) {
      if (booking.status !== 'confirmed') continue
      const inMonth = nightsBetween(booking.check_in, booking.check_out).filter(
        (night) => night.getMonth() === month.getMonth() && night.getFullYear() === month.getFullYear(),
      ).length
      if (!inMonth) continue
      nights += inMonth
      const code = currencyCode(booking.currency)
      payout.set(code, (payout.get(code) ?? 0) + booking.owner_payout)
      if (booking.manager_id === user?.id) {
        commission.set(code, (commission.get(code) ?? 0) + booking.manager_commission)
      }
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
              className="icon-button icon-button-lg"
              onClick={() => navigate(`/villa/${villa.id}/setup`)}
              aria-label={t('villa.setupAria')}
            >
              <GearIcon className="icon-button-glyph" />
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
              {formatMoneyGroups(isOwner ? monthStats.payout : monthStats.commission, villa.currency)}
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
            setSelectedBookingId(null)
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
            setSelectedBookingId(null)
            setOwnerAction(null)
            navigate(`/villa/${villa.id}/booking/new?date=${toISODate(date)}`)
          }}
          selectedISO={selectedISO}
          onSelectBooking={(booking) => {
            setSelectedISO(null)
            setSelectedBlock(null)
            setOwnerAction(null)
            setBlockError(null)
            setSelectedBookingId(booking.id)
          }}
          onSelectBlock={(block) => {
            setSelectedBookingId(null)
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

        {selectedBooking && (
          <BookingDetailCard
            booking={selectedBooking}
            client={clients.get(selectedBooking.id) ?? null}
            // As the edit page allows today: the owner, or the makler credited
            // on it. A hold is read-only for everyone there, so no pencil.
            canEdit={
              selectedBooking.status === 'confirmed' && (isOwner || selectedBooking.manager_id === user.id)
            }
            onEdit={() => navigate(`/booking/${selectedBooking.id}`)}
            onDismiss={() => setSelectedBookingId(null)}
          />
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
                  {formatMoney(booking.total_price, currencyCode(booking.currency))}
                  <div className="row-sub">
                    {isOwner
                      ? t('villa.rowPayout', { amount: formatMoney(booking.owner_payout, currencyCode(booking.currency)) })
                      : booking.manager_id === user.id
                        ? t('villa.rowYou', { amount: formatMoney(booking.manager_commission, currencyCode(booking.currency)) })
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
 * A booked or held night that was tapped: who the guest is, how to reach
 * them, and whether the deposit is in. Only the pencil leads on to the full
 * edit page, and only for someone who may edit the booking.
 */
function BookingDetailCard({
  booking,
  client,
  canEdit,
  onEdit,
  onDismiss,
}: {
  booking: Booking
  client: BookingClient | null
  canEdit: boolean
  onEdit: () => void
  onDismiss: () => void
}) {
  const { lang, t, tn } = useI18n()
  const held = booking.status === 'pending'
  const phone = booking.client_phone?.trim() ?? ''
  const telegramName = client?.telegram_name?.trim() ?? ''
  const username = client?.telegram_username ?? null
  const typedName = booking.client_name.trim()
  const note = booking.notes?.trim() ?? ''

  return (
    <div className="day-card">
      <div className="day-card-head">
        <div>
          <h4>{formatRange(booking.check_in, booking.check_out, lang)}</h4>
          <span className={`badge ${held ? 'badge-warning' : 'badge-accent'}`}>
            {held ? t('villa.bookingWaiting') : t('booking.statusConfirmed')}
          </span>
        </div>
        <div className="day-card-actions">
          {canEdit && (
            <button type="button" className="icon-button day-card-edit" onClick={onEdit} aria-label={t('villa.editBooking')}>
              <PencilIcon className="day-card-edit-glyph" />
            </button>
          )}
          <button type="button" className="day-card-dismiss" onClick={onDismiss} aria-label={t('common.close')}>
            ×
          </button>
        </div>
      </div>

      <dl className="summary">
        {phone && (
          <div className="summary-row">
            <dt>{t('booking.phoneLabel')}</dt>
            <dd>
              {/* Digits and + only in the URI; the number is shown as it was typed. */}
              <a
                className="day-card-link"
                href={`tel:${phone.replace(/[^\d+]/g, '')}`}
                aria-label={t('booking.callClient', { phone })}
              >
                {phone}
              </a>
            </dd>
          </div>
        )}

        {booking.client_user_id && telegramName ? (
          <div className="summary-row">
            <dt>{t('villa.cardTelegram')}</dt>
            <dd>
              {username ? (
                <a
                  className="day-card-link"
                  href={`https://t.me/${encodeURIComponent(username)}`}
                  target="_blank"
                  rel="noreferrer"
                  aria-label={t('villa.openTelegram', { username })}
                  onClick={(e) => {
                    if (openTelegramLink(`https://t.me/${encodeURIComponent(username)}`)) e.preventDefault()
                  }}
                >
                  {telegramName}
                </a>
              ) : (
                telegramName
              )}
            </dd>
          </div>
        ) : (
          typedName && (
            <div className="summary-row">
              <dt>{t('villa.cardClient')}</dt>
              <dd>{typedName}</dd>
            </div>
          )
        )}

        <div className="summary-row">
          <dt>{t('villa.deposit')}</dt>
          <dd>
            <span className={`badge ${booking.deposit_paid ? 'badge-success' : 'badge-warning'}`}>
              {booking.deposit_paid ? t('villa.depositPaid') : t('villa.depositNotPaid')}
            </span>{' '}
            {formatMoney(booking.deposit_amount, DEPOSIT_CURRENCY)}
          </dd>
        </div>

        {booking.guests_count != null && (
          <div className="summary-row">
            <dt>{t('villa.cardGuests')}</dt>
            <dd>{tn('guests', booking.guests_count)}</dd>
          </div>
        )}

        {booking.client_type && (
          <div className="summary-row">
            <dt>{t('booking.clientTypeLabel')}</dt>
            <dd>{t(`clientType.${booking.client_type}`)}</dd>
          </div>
        )}

        {note && (
          <div className="summary-row">
            <dt>{t('booking.notesLabel')}</dt>
            <dd className="day-card-note">{note}</dd>
          </div>
        )}
      </dl>
    </div>
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
          <dd>{formatMoney(villa.deposit_amount, DEPOSIT_CURRENCY)}</dd>
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
