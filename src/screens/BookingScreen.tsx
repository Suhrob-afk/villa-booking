import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import {
  createBooking,
  fetchBooking,
  fetchVilla,
  setBookingStatus,
  updateBooking,
} from '../lib/api'
import { useAuth } from '../lib/auth'
import { addDays, formatRange, nightCount, parseISODate, startOfToday, toISODate } from '../lib/dates'
import { formatMoney, formatPercent } from '../lib/format'
import { quoteRange, splitTotal } from '../lib/pricing'
import { confirmAction, notify } from '../lib/telegram'
import { useBackButton } from '../lib/useBackButton'
import type { Booking, Villa } from '../lib/types'
import { Alert, ErrorState, Loading, TopBar } from '../components/ui'

/** Turns Postgres constraint noise into something a manager can act on. */
function humanizeError(message: string): string {
  if (message.includes('bookings_no_overlap')) return 'Those dates overlap another booking for this villa.'
  if (message.includes('bookings_dates_ordered')) return 'Check-out must be after check-in.'
  if (message.includes('Owners may only cancel')) return 'Owners can only cancel a booking, not edit it.'
  if (message.includes('Only the villa owner')) return 'Only the villa owner can settle commissions.'
  return message
}

export default function BookingScreen() {
  const { bookingId, villaId: villaIdParam } = useParams<{ bookingId?: string; villaId?: string }>()
  const [searchParams] = useSearchParams()
  const navigate = useNavigate()
  const { user } = useAuth()
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
  const [notes, setNotes] = useState('')
  /** Once the manager types a total by hand we stop overwriting it. */
  const [totalEdited, setTotalEdited] = useState(false)

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
        setNotes(bookingRow.notes ?? '')
        setTotalEdited(true) // an existing total is authoritative
      }
    } catch (err) {
      setLoadError((err as Error).message)
    } finally {
      setLoading(false)
    }
  }, [bookingId, isNew, searchParams, villaIdParam])

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

  const isOwner = Boolean(villa && user && villa.owner_id === user.id)
  const isCancelled = booking?.status === 'cancelled'
  const readOnly = isOwner || isCancelled

  // Existing bookings keep the rate they were created with.
  const commissionRate = booking?.commission_rate_snapshot ?? villa?.commission_rate ?? 0
  const split = useMemo(
    () => splitTotal(Number(total) || 0, commissionRate, villa?.platform_fee_rate ?? 0),
    [total, commissionRate, villa],
  )

  async function save() {
    if (!villa || !user) return
    if (!clientName.trim()) return setError('Enter the client’s name.')
    if (!checkIn || !checkOut) return setError('Pick both dates.')
    if (checkOut <= checkIn) return setError('Check-out must be after check-in.')

    setSaving(true)
    setError(null)
    try {
      const payload = {
        client_name: clientName.trim(),
        client_phone: clientPhone.trim() || null,
        check_in: checkIn,
        check_out: checkOut,
        total_price: Number(total) || 0,
        notes: notes.trim() || null,
      }
      if (isNew) {
        await createBooking({ ...payload, villa_id: villa.id, manager_id: user.id })
      } else {
        await updateBooking(booking!.id, payload)
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
    const question =
      next === 'cancelled'
        ? 'Cancel this booking? Its days go back to available.'
        : 'Reopen this booking and block those days again?'
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
  const showResetTotal = !readOnly && quote.nights > 0 && Number(total) !== quote.suggestedTotal

  return (
    <>
      <TopBar
        title={isNew ? 'New booking' : booking?.client_name || 'Booking'}
        subtitle={villa.name}
        onBack={goBack}
      />
      <main className="screen">
        {error && <Alert>{error}</Alert>}
        {isCancelled && <Alert kind="info">This booking is cancelled. Its days are available again.</Alert>}
        {isOwner && !isNew && !isCancelled && (
          <Alert kind="info">You can view and cancel this booking. Only managers can edit the details.</Alert>
        )}

        <div className="card card-pad">
          <div className="field">
            <label htmlFor="client">Client name</label>
            <input
              id="client"
              value={clientName}
              disabled={readOnly}
              onChange={(e) => setClientName(e.target.value)}
              placeholder="Full name"
            />
          </div>
          <div className="field">
            <label htmlFor="phone">Phone</label>
            <input
              id="phone"
              type="tel"
              inputMode="tel"
              value={clientPhone}
              disabled={readOnly}
              onChange={(e) => setClientPhone(e.target.value)}
              placeholder="+998 90 000 00 00"
            />
          </div>
          <div className="field-row">
            <div className="field">
              <label htmlFor="check-in">Check-in</label>
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
              <label htmlFor="check-out">Check-out</label>
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
          {nights > 0 && <p className="field-hint">{formatRange(checkIn, checkOut)}</p>}
        </div>

        <p className="section-title">Price</p>
        <div className="card card-pad">
          {quote.nights > 0 && (
            <dl className="summary" style={{ marginBottom: 10 }}>
              {quote.weekdayNights > 0 && (
                <div className="summary-row muted">
                  <dt>
                    {quote.weekdayNights} weekday night{quote.weekdayNights === 1 ? '' : 's'} ×{' '}
                    {formatMoney(villa.weekday_price, villa.currency)}
                  </dt>
                  <dd>{formatMoney(quote.weekdayNights * villa.weekday_price, villa.currency)}</dd>
                </div>
              )}
              {quote.weekendNights > 0 && (
                <div className="summary-row muted">
                  <dt>
                    {quote.weekendNights} weekend night{quote.weekendNights === 1 ? '' : 's'} ×{' '}
                    {formatMoney(villa.weekend_price, villa.currency)}
                  </dt>
                  <dd>{formatMoney(quote.weekendNights * villa.weekend_price, villa.currency)}</dd>
                </div>
              )}
            </dl>
          )}

          <div className="field" style={{ marginBottom: 6 }}>
            <label htmlFor="total">Total price ({villa.currency})</label>
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
          {showResetTotal && (
            <button
              type="button"
              className="button button-secondary button-small"
              onClick={() => {
                setTotalEdited(false)
                setTotal(String(quote.suggestedTotal))
              }}
            >
              Reset to {formatMoney(quote.suggestedTotal, villa.currency)}
            </button>
          )}
          {!readOnly && <p className="field-hint">Pre-filled from the villa’s rates — adjust it for discounts or extras.</p>}
        </div>

        <p className="section-title">Split</p>
        <div className="card card-pad">
          <dl className="summary">
            <div className="summary-row total">
              <dt>Total</dt>
              <dd>{formatMoney(Number(total) || 0, villa.currency)}</dd>
            </div>
            {(villa.platform_fee_rate > 0 || split.platformFee > 0) && (
              <div className="summary-row">
                <dt>Platform fee ({formatPercent(villa.platform_fee_rate)})</dt>
                <dd>−{formatMoney(split.platformFee, villa.currency)}</dd>
              </div>
            )}
            <div className="summary-row">
              <dt>Manager commission ({formatPercent(commissionRate)})</dt>
              <dd>{formatMoney(split.managerCommission, villa.currency)}</dd>
            </div>
            <div className="summary-row total">
              <dt>Owner payout</dt>
              <dd>{formatMoney(split.ownerPayout, villa.currency)}</dd>
            </div>
          </dl>
          {booking && (
            <div style={{ marginTop: 12, display: 'flex', gap: 8 }}>
              <span className={`badge ${booking.status === 'confirmed' ? 'badge-accent' : 'badge-danger'}`}>
                {booking.status === 'confirmed' ? 'Confirmed' : 'Cancelled'}
              </span>
              <span className={`badge ${booking.commission_status === 'paid' ? 'badge-success' : 'badge-warning'}`}>
                Commission {booking.commission_status}
              </span>
            </div>
          )}
        </div>

        {!readOnly && (
          <div className="field" style={{ marginTop: 16 }}>
            <label htmlFor="notes">Notes</label>
            <textarea id="notes" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Arrival time, extras, deposit…" />
          </div>
        )}
        {readOnly && notes && (
          <>
            <p className="section-title">Notes</p>
            <div className="card card-pad" style={{ whiteSpace: 'pre-wrap' }}>{notes}</div>
          </>
        )}

        {!readOnly && (
          <div className="button-row">
            <button type="button" className="button" disabled={saving} onClick={() => void save()}>
              {saving ? 'Saving…' : isNew ? 'Create booking' : 'Save changes'}
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
              {booking?.status === 'confirmed' ? 'Cancel booking' : 'Reopen booking'}
            </button>
          </div>
        )}
      </main>
    </>
  )
}
