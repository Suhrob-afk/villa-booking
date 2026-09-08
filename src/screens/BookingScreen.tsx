import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import {
  createBooking,
  fetchBooking,
  fetchVilla,
  isAssignedMakler,
  setBookingStatus,
  setDepositPaid as saveDepositPaid,
  updateBooking,
} from '../lib/api'
import { useAuth } from '../lib/auth'
import { addDays, formatRange, nightCount, parseISODate, startOfToday, toISODate } from '../lib/dates'
import { bookingTitle, formatMoney, formatPercent } from '../lib/format'
import { useI18n } from '../lib/i18n'
import { quoteRange, splitTotal } from '../lib/pricing'
import type { StringKey } from '../lib/strings'
import { confirmAction, notify } from '../lib/telegram'
import { useBackButton } from '../lib/useBackButton'
import { CLIENT_TYPES, type Booking, type ClientType, type PricingMode, type Villa } from '../lib/types'
import { Alert, ErrorState, Loading, TopBar } from '../components/ui'

const MIN_DEPOSIT = 200000

/**
 * Postgres raises its constraint messages in English only. Match them once and
 * hand back a translation key; anything unrecognised falls through as the raw
 * database text, which is still better than swallowing it.
 */
const DB_ERROR_KEYS: [needle: string, key: StringKey][] = [
  ['Deposit must be at least', 'error.depositTooLow'],
  ['Total price must be at least', 'error.totalBelowOwnerNet'],
  ['net amount for this booking', 'error.ownerNetRequired'],
  ['not registered as a Makler', 'error.notAMakler'],
  ['belongs to a makler', 'error.belongsToMakler'],
  ['bookings_no_overlap', 'error.datesOverlap'],
  ['bookings_dates_ordered', 'error.checkOutAfterCheckIn'],
  ['Owners may only cancel', 'error.ownersMayOnlyCancel'],
  ['Only the villa owner', 'error.ownerSettlesCommission'],
]

export default function BookingScreen() {
  const { bookingId, villaId: villaIdParam } = useParams<{ bookingId?: string; villaId?: string }>()
  const [searchParams] = useSearchParams()
  const navigate = useNavigate()
  const { user } = useAuth()
  const { lang, t, tn } = useI18n()
  const userId = user?.id
  const isNew = !bookingId

  const [villa, setVilla] = useState<Villa | null>(null)
  const [booking, setBooking] = useState<Booking | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  // --- form state ---------------------------------------------------------
  const [clientName, setClientName] = useState('')
  const [clientPhone, setClientPhone] = useState('')
  const [checkIn, setCheckIn] = useState('')
  const [checkOut, setCheckOut] = useState('')
  const [total, setTotal] = useState('')
  const [deposit, setDeposit] = useState('')
  const [pricingMode, setPricingMode] = useState<PricingMode>('percentage')
  const [ownerNet, setOwnerNet] = useState('')
  /** Same idea as totalEdited: stop pre-filling once it is typed by hand. */
  const [ownerNetEdited, setOwnerNetEdited] = useState(false)
  const [clientType, setClientType] = useState<ClientType | ''>('')
  const [depositPaid, setDepositPaid] = useState(false)

  /** Whether the signed-in user is a standing makler on this villa. */
  const [assignedMakler, setAssignedMakler] = useState(false)
  const [notes, setNotes] = useState('')
  /** Once the makler types a total by hand we stop overwriting it. */
  const [totalEdited, setTotalEdited] = useState(false)

  const humanizeError = useCallback(
    (message: string): string => {
      const match = DB_ERROR_KEYS.find(([needle]) => message.includes(needle))
      return match ? t(match[1], { min: MIN_DEPOSIT.toLocaleString('en-US') }) : message
    },
    [t],
  )

  const load = useCallback(async () => {
    setLoading(true)
    setLoadError(null)
    try {
      if (isNew) {
        const villaRow = await fetchVilla(villaIdParam!)
        setVilla(villaRow)
        const startISO = searchParams.get('date') ?? toISODate(startOfToday())
        setCheckIn(startISO)
        setCheckOut(toISODate(addDays(parseISODate(startISO), 1)))
        setDeposit(String(villaRow.deposit_amount))
        if (userId) setAssignedMakler(await isAssignedMakler(villaRow.id, userId))
      } else {
        const bookingRow = await fetchBooking(bookingId!)
        const villaRow = await fetchVilla(bookingRow.villa_id)
        setBooking(bookingRow)
        setVilla(villaRow)
        setClientName(bookingRow.client_name)
        setClientPhone(bookingRow.client_phone ?? '')
        setCheckIn(bookingRow.check_in)
        setCheckOut(bookingRow.check_out)
        setTotal(String(bookingRow.total_price))
        setDeposit(String(bookingRow.deposit_amount))
        setPricingMode(bookingRow.pricing_mode)
        setClientType(bookingRow.client_type ?? '')
        setDepositPaid(bookingRow.deposit_paid)
        if (userId) setAssignedMakler(await isAssignedMakler(villaRow.id, userId))
        setOwnerNet(bookingRow.owner_net_amount === null ? '' : String(bookingRow.owner_net_amount))
        setOwnerNetEdited(true)
        setNotes(bookingRow.notes ?? '')
        setTotalEdited(true) // an existing total is authoritative
      }
    } catch (err) {
      setLoadError((err as Error).message)
    } finally {
      setLoading(false)
    }
  }, [bookingId, isNew, searchParams, villaIdParam, userId])

  useEffect(() => {
    void load()
  }, [load])

  const goBack = useCallback(() => {
    const target = villa ? `/villa/${villa.id}` : '/'
    navigate(target)
  }, [navigate, villa])
  useBackButton(goBack)

  const quote = useMemo(
    () => (villa ? quoteRange(villa, checkIn, checkOut) : { nights: 0, weekdayNights: 0, weekendNights: 0, suggestedTotal: 0 }),
    [villa, checkIn, checkOut],
  )

  // Pre-fill the total from the villa's rates while it is still untouched.
  useEffect(() => {
    if (totalEdited || !villa) return
    setTotal(quote.nights > 0 ? String(quote.suggestedTotal) : '')
  }, [quote.nights, quote.suggestedTotal, totalEdited, villa])

  // The owner's net starts from the same rate card -- it is what the villa
  // would have earned at list price -- and the makler adjusts from there.
  useEffect(() => {
    if (ownerNetEdited || !villa || pricingMode !== 'owner_net') return
    setOwnerNet(quote.nights > 0 ? String(quote.suggestedTotal) : '')
  }, [quote.nights, quote.suggestedTotal, ownerNetEdited, villa, pricingMode])

  const isOwner = Boolean(villa && user && villa.owner_id === user.id)
  /** An owner filing it themselves, rather than a makler with a standing link. */
  const filingAsOwner = isOwner && !assignedMakler
  /**
   * Whether a makler is actually attached to THIS booking. A makler filing for
   * themselves always is; an owner only once they have confirmed a reference.
   * For a saved booking the row itself is the answer -- reading the form state
   * there would wrongly zero out a makler's commission whenever an owner
   * opened their booking.
   */
  const maklerCredited = isNew ? !filingAsOwner : Boolean(booking?.manager_id)
  const noMaklerCredited = !maklerCredited
  const isCancelled = booking?.status === 'cancelled'
  /**
   * The owner logging a booking on their own villa with nobody credited.
   * These are arranged by phone outside the app, so the form drops client
   * identity, the makler credit and the commission split: there is no
   * commission to split and no contact to store that Notes cannot hold.
   * An owner looking at a *makler's* booking is not this -- they still see
   * the client and the split, they just cannot edit them.
   */
  const ownerLogged = filingAsOwner && (isNew || booking?.manager_id === null)
  const readOnly = (isOwner && !ownerLogged) || isCancelled

  // Existing bookings keep the rate they were created with.
  const villaRate = booking?.commission_rate_snapshot ?? villa?.commission_rate ?? 0
  /**
   * No makler, no commission. The villa's rate is only a default for a makler
   * who gets attached later -- it must not colour the preview before then,
   * which is exactly what bookings_compute() does server-side.
   */
  const commissionRate = maklerCredited ? villaRate : 0
  const split = useMemo(
    () =>
      splitTotal(
        Number(total) || 0,
        commissionRate,
        villa?.platform_fee_rate ?? 0,
        maklerCredited ? pricingMode : 'percentage',
        Number(ownerNet) || 0,
      ),
    [total, commissionRate, villa, pricingMode, ownerNet, maklerCredited],
  )

  async function save() {
    if (!villa || !user) return
    if (!ownerLogged && !clientName.trim()) return setError(t('error.clientNameRequired'))
    if (!checkIn || !checkOut) return setError(t('error.datesRequired'))
    if (checkOut <= checkIn) return setError(t('error.checkOutAfterCheckIn'))
    const depositValue = Number(deposit)
    if (!Number.isFinite(depositValue) || depositValue < MIN_DEPOSIT) {
      return setError(t('error.depositTooLow', { min: MIN_DEPOSIT.toLocaleString('en-US') }))
    }

    const ownerNetValue = pricingMode === 'owner_net' && !noMaklerCredited ? Number(ownerNet) : null
    if (pricingMode === 'owner_net' && !noMaklerCredited) {
      if (!Number.isFinite(ownerNetValue) || ownerNetValue === null) {
        return setError(t('error.ownerNetRequired'))
      }
      if (split.managerCommission < 0) {
        return setError(t('error.totalBelowOwnerNet'))
      }
    }

    setSaving(true)
    setError(null)
    try {
      const payload = {
        // client_name is NOT NULL in the schema; an owner-logged booking has
        // no client identity to store, so it goes in empty and the lists fall
        // back to a label (see bookingTitle).
        client_name: ownerLogged ? '' : clientName.trim(),
        client_phone: ownerLogged ? null : clientPhone.trim() || null,
        check_in: checkIn,
        check_out: checkOut,
        total_price: Number(total) || 0,
        deposit_amount: depositValue,
        pricing_mode: pricingMode,
        owner_net_amount: ownerNetValue,
        client_type: clientType || null,
        deposit_paid: depositPaid,
        notes: notes.trim() || null,
      }
      // A makler always credits themselves; an owner logging their own
      // booking credits nobody, so no commission is owed on it.
      const managerId = filingAsOwner ? null : user.id
      if (isNew) {
        await createBooking({ ...payload, villa_id: villa.id, manager_id: managerId })
      } else {
        await updateBooking(booking!.id, { ...payload, manager_id: booking!.manager_id })
      }
      notify('success')
      navigate(`/villa/${villa.id}`)
    } catch (err) {
      notify('error')
      setError(humanizeError((err as Error).message))
    } finally {
      setSaving(false)
    }
  }

  async function toggleCancelled() {
    if (!booking) return
    const next = booking.status === 'confirmed' ? 'cancelled' : 'confirmed'
    const question = next === 'cancelled' ? t('booking.cancelConfirm') : t('booking.reopenConfirm')
    if (!(await confirmAction(question))) return
    try {
      const updated = await setBookingStatus(booking.id, next)
      setBooking(updated)
      notify('success')
    } catch (err) {
      notify('error')
      setError(humanizeError((err as Error).message))
    }
  }

  if (loading) return <Loading />
  if (loadError) return <ErrorState message={loadError} onRetry={load} />
  if (!villa || !user) return null

  const nights = nightCount(checkIn, checkOut)
  /** A stay whose check-in has already passed: logged after the fact. */
  const isPastStay = Boolean(checkIn) && checkIn < toISODate(startOfToday())
  const showResetTotal = !readOnly && quote.nights > 0 && Number(total) !== quote.suggestedTotal

  return (
    <>
      <TopBar
        title={isNew ? t('booking.titleNew') : bookingTitle(booking?.client_name ?? '', t('booking.title'))}
        subtitle={villa.name}
        onBack={goBack}
      />
      <main className="screen">
        {error && <Alert>{error}</Alert>}
        {isPastStay && !isCancelled && <Alert kind="info">{t('booking.pastDateNotice')}</Alert>}
        {isCancelled && <Alert kind="info">{t('booking.cancelledNotice')}</Alert>}
        {isOwner && !isNew && !isCancelled && <Alert kind="info">{t('booking.ownerReadOnly')}</Alert>}

        <div className="card card-pad">
          {!ownerLogged && (
            <>
              <div className="field">
                <label htmlFor="client">{t('booking.clientNameLabel')}</label>
                <input
                  id="client"
                  value={clientName}
                  disabled={readOnly}
                  onChange={(e) => setClientName(e.target.value)}
                  placeholder={t('booking.clientNamePlaceholder')}
                />
              </div>
              <div className="field">
                <label htmlFor="phone">{t('booking.phoneLabel')}</label>
                <input
                  id="phone"
                  type="tel"
                  inputMode="tel"
                  value={clientPhone}
                  disabled={readOnly}
                  onChange={(e) => setClientPhone(e.target.value)}
                  placeholder={t('booking.phonePlaceholder')}
                />
              </div>
            </>
          )}
          <div className="field-row">
            <div className="field">
              <label htmlFor="check-in">{t('booking.checkIn')}</label>
              <input
                id="check-in"
                type="date"
                value={checkIn}
                disabled={readOnly}
                onChange={(e) => {
                  const value = e.target.value
                  setCheckIn(value)
                  if (value && checkOut <= value) setCheckOut(toISODate(addDays(parseISODate(value), 1)))
                }}
              />
            </div>
            <div className="field">
              <label htmlFor="check-out">{t('booking.checkOut')}</label>
              <input
                id="check-out"
                type="date"
                value={checkOut}
                min={checkIn || undefined}
                disabled={readOnly}
                onChange={(e) => setCheckOut(e.target.value)}
              />
            </div>
          </div>
          {nights > 0 && <p className="field-hint">{formatRange(checkIn, checkOut, lang)}</p>}

          <div className="field" style={{ marginTop: 14, marginBottom: 0 }}>
            <label htmlFor="client-type">{t('booking.clientTypeLabel')}</label>
            <select
              id="client-type"
              value={clientType}
              disabled={readOnly}
              onChange={(e) => setClientType(e.target.value as ClientType | '')}
            >
              <option value="">{t('booking.clientTypeNone')}</option>
              {CLIENT_TYPES.map((key) => (
                <option key={key} value={key}>
                  {t(`clientType.${key}`)}
                </option>
              ))}
            </select>
          </div>
        </div>

        <p className="section-title">{t('booking.priceTitle')}</p>

        {!readOnly && !noMaklerCredited && (
          <div className="segmented" role="tablist" style={{ marginBottom: 12 }}>
            <button
              type="button"
              className={`segmented-item${pricingMode === 'percentage' ? ' segmented-item-active' : ''}`}
              onClick={() => setPricingMode('percentage')}
            >
              {t('booking.modePercentage')}
            </button>
            <button
              type="button"
              className={`segmented-item${pricingMode === 'owner_net' ? ' segmented-item-active' : ''}`}
              onClick={() => setPricingMode('owner_net')}
            >
              {t('booking.modeOwnerNet')}
            </button>
          </div>
        )}

        <div className="card card-pad">
          {quote.nights > 0 && (
            <dl className="summary" style={{ marginBottom: 10 }}>
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
            </dl>
          )}

          {pricingMode === 'owner_net' && !noMaklerCredited && (
            <div className="field">
              <label htmlFor="owner-net">{t('booking.ownerNetLabel', { currency: villa.currency })}</label>
              <input
                id="owner-net"
                type="number"
                inputMode="decimal"
                min="0"
                step="1000"
                value={ownerNet}
                disabled={readOnly}
                onChange={(e) => {
                  setOwnerNetEdited(true)
                  setOwnerNet(e.target.value)
                }}
              />
              {!readOnly && (
                <p className="field-hint">{t('booking.ownerNetHint')}</p>
              )}
            </div>
          )}

          <div className="field" style={{ marginBottom: 6 }}>
            <label htmlFor="total">
              {pricingMode === 'owner_net'
                ? t('booking.chargedLabel', { currency: villa.currency })
                : t('booking.totalLabel', { currency: villa.currency })}
            </label>
            <input
              id="total"
              type="number"
              inputMode="decimal"
              min="0"
              step="0.01"
              value={total}
              disabled={readOnly}
              onChange={(e) => {
                setTotalEdited(true)
                setTotal(e.target.value)
              }}
            />
          </div>
          {showResetTotal && pricingMode === 'percentage' && (
            <button
              type="button"
              className="button button-secondary button-small"
              onClick={() => {
                setTotalEdited(false)
                setTotal(String(quote.suggestedTotal))
              }}
            >
              {t('booking.resetTo', { amount: formatMoney(quote.suggestedTotal, villa.currency) })}
            </button>
          )}
          {!readOnly && (
            <p className="field-hint">
              {pricingMode === 'owner_net' ? t('booking.chargedHint') : t('booking.totalHint')}
            </p>
          )}

          {pricingMode === 'owner_net' && !noMaklerCredited && (
            <div
              className={`alert ${split.managerCommission < 0 ? 'alert-error' : 'alert-info'}`}
              style={{ marginTop: 14, marginBottom: 0 }}
            >
              {split.managerCommission < 0
                ? t('error.totalBelowOwnerNet')
                : t('booking.yourCommission', {
                    amount: formatMoney(split.managerCommission, villa.currency),
                  })}
              {villa.platform_fee_rate > 0 && split.managerCommission >= 0 && (
                <>
                  {' '}
                  {t('booking.afterPlatformFee', { amount: formatMoney(split.platformFee, villa.currency) })}
                </>
              )}
            </div>
          )}

          <div className="field" style={{ marginTop: 14, marginBottom: 0 }}>
            <label htmlFor="deposit">{t('booking.depositLabel', { currency: villa.currency })}</label>
            <input
              id="deposit"
              type="number"
              inputMode="decimal"
              min={MIN_DEPOSIT}
              step="1000"
              value={deposit}
              disabled={readOnly}
              onChange={(e) => setDeposit(e.target.value)}
            />
            {!readOnly && (
              <p className="field-hint">
                {/* Only the full hint can mention a split; owner-logged bookings have none. */}
                {t(ownerLogged ? 'booking.depositHintSimple' : 'booking.depositHint', {
                  min: MIN_DEPOSIT.toLocaleString('en-US'),
                })}
              </p>
            )}

            <div className="toggle-row">
              <span>{t('booking.depositPaidQuestion')}</span>
              <button
                type="button"
                className={`toggle ${depositPaid ? 'paid' : ''}`}
                disabled={readOnly && !isOwner}
                onClick={async () => {
                  const next = !depositPaid
                  setDepositPaid(next)
                  // On an existing booking the owner can flip this on its own,
                  // without saving the whole form.
                  if (!isNew && booking) {
                    try {
                      await saveDepositPaid(booking.id, next)
                    } catch (err) {
                      setDepositPaid(!next)
                      setError(humanizeError((err as Error).message))
                    }
                  }
                }}
              >
                {depositPaid ? t('booking.depositPaidYes') : t('booking.depositPaidNo')}
              </button>
            </div>
          </div>
        </div>

        {!ownerLogged && (
          <>
          <p className="section-title">{t('booking.splitTitle')}</p>
          <div className="card card-pad">
            <dl className="summary">
              <div className="summary-row total">
                <dt>{t('booking.splitTotal')}</dt>
                <dd>{formatMoney(Number(total) || 0, villa.currency)}</dd>
              </div>
              {(villa.platform_fee_rate > 0 || split.platformFee > 0) && (
                <div className="summary-row">
                  <dt>{t('booking.splitPlatformFee', { rate: formatPercent(villa.platform_fee_rate) })}</dt>
                  <dd>−{formatMoney(split.platformFee, villa.currency)}</dd>
                </div>
              )}
              <div className="summary-row">
                <dt>
                  {!maklerCredited
                    ? t('booking.splitNoMakler')
                    : pricingMode === 'owner_net'
                      ? t('booking.splitSpread')
                      : t('booking.splitCommission', { rate: formatPercent(commissionRate) })}
                </dt>
                <dd>{formatMoney(split.managerCommission, villa.currency)}</dd>
              </div>
              <div className="summary-row total">
                <dt>{t('booking.splitOwnerPayout')}</dt>
                <dd>{formatMoney(split.ownerPayout, villa.currency)}</dd>
              </div>
              <div className="summary-row muted">
                <dt>{t('booking.splitDeposit')}</dt>
                <dd>{formatMoney(Number(deposit) || 0, villa.currency)}</dd>
              </div>
            </dl>
            {booking && (
              <div style={{ marginTop: 12, display: 'flex', gap: 8 }}>
                <span className={`badge ${booking.status === 'confirmed' ? 'badge-accent' : 'badge-danger'}`}>
                  {booking.status === 'confirmed' ? t('booking.statusConfirmed') : t('booking.statusCancelled')}
                </span>
                <span className={`badge ${booking.commission_status === 'paid' ? 'badge-success' : 'badge-warning'}`}>
                  {t('booking.commissionBadge', {
                    status: booking.commission_status === 'paid' ? t('common.paid') : t('common.unpaid'),
                  })}
                </span>
              </div>
            )}
          </div>
          </>
        )}

        {!readOnly && (
          <div className="field" style={{ marginTop: 16 }}>
            <label htmlFor="notes">{t('booking.notesLabel')}</label>
            <textarea
              id="notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder={t('booking.notesPlaceholder')}
            />
          </div>
        )}
        {readOnly && notes && (
          <>
            <p className="section-title">{t('booking.notesLabel')}</p>
            <div className="card card-pad" style={{ whiteSpace: 'pre-wrap' }}>{notes}</div>
          </>
        )}

        {!readOnly && (
          <div className="button-row">
            <button type="button" className="button" disabled={saving} onClick={() => void save()}>
              {saving ? t('common.saving') : isNew ? t('booking.create') : t('common.saveChanges')}
            </button>
          </div>
        )}

        {!isNew && (
          <div className="button-row">
            <button
              type="button"
              className={booking?.status === 'confirmed' ? 'button button-danger' : 'button button-secondary'}
              onClick={() => void toggleCancelled()}
            >
              {booking?.status === 'confirmed' ? t('booking.cancel') : t('booking.reopen')}
            </button>
          </div>
        )}
      </main>
    </>
  )
}
