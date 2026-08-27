import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import MonthCalendar from '../components/MonthCalendar'
import { fetchBookings, fetchVilla } from '../lib/api'
import { useAuth } from '../lib/auth'
import { addMonths, formatRange, nightsBetween, startOfMonth, startOfToday, toISODate } from '../lib/dates'
import { formatMoney } from '../lib/format'
import { useBackButton } from '../lib/useBackButton'
import type { Booking, Villa } from '../lib/types'
import { Empty, ErrorState, Loading, TopBar } from '../components/ui'

export default function VillaCalendar() {
  const { villaId } = useParams<{ villaId: string }>()
  const navigate = useNavigate()
  const { user } = useAuth()

  const [villa, setVilla] = useState<Villa | null>(null)
  const [bookings, setBookings] = useState<Booking[]>([])
  const [month, setMonth] = useState(() => startOfMonth(new Date()))
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const goBack = useCallback(() => navigate('/'), [navigate])
  useBackButton(goBack)

  const load = useCallback(async () => {
    if (!villaId) return
    setLoading(true)
    setError(null)
    try {
      const [villaRow, bookingRows] = await Promise.all([fetchVilla(villaId), fetchBookings(villaId)])
      setVilla(villaRow)
      setBookings(bookingRows)
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
              aria-label="Villa setup"
            >
              ⚙
            </button>
          ) : undefined
        }
      />
      <main className="screen">
        <div className="stat-strip">
          <div className="stat">
            <div className="stat-label">Nights booked</div>
            <div className="stat-value">{monthStats.nights}</div>
          </div>
          <div className="stat">
            <div className="stat-label">{isOwner ? 'Your payout' : 'Your commission'}</div>
            <div className="stat-value">
              {formatMoney(isOwner ? monthStats.payout : monthStats.commission, villa.currency)}
            </div>
          </div>
        </div>

        <MonthCalendar
          month={month}
          bookings={bookings}
          onPrevMonth={() => setMonth((m) => addMonths(m, -1))}
          onNextMonth={() => setMonth((m) => addMonths(m, 1))}
          onSelectDay={
            isOwner
              ? undefined
              : (date) => navigate(`/villa/${villa.id}/booking/new?date=${toISODate(date)}`)
          }
          onSelectBooking={(booking) => navigate(`/booking/${booking.id}`)}
        />

        {!isOwner && (
          <div className="button-row">
            <button
              type="button"
              className="button button-secondary"
              onClick={() => navigate(`/villa/${villa.id}/booking/new`)}
            >
              New booking
            </button>
          </div>
        )}

        <p className="section-title">Upcoming</p>
        {upcoming.length === 0 ? (
          <Empty title="Nothing booked yet">
            {isOwner ? 'Bookings your managers create will show up here.' : 'Tap an available day to add a booking.'}
          </Empty>
        ) : (
          <div className="list">
            {upcoming.map((booking) => (
              <button type="button" className="row" key={booking.id} onClick={() => navigate(`/booking/${booking.id}`)}>
                <div className="row-main">
                  <div className="row-title">{booking.client_name}</div>
                  <div className="row-sub">{formatRange(booking.check_in, booking.check_out)}</div>
                </div>
                <div className="row-amount">
                  {formatMoney(booking.total_price, villa.currency)}
                  <div className="row-sub">
                    {isOwner
                      ? `payout ${formatMoney(booking.owner_payout, villa.currency)}`
                      : booking.manager_id === user.id
                        ? `you ${formatMoney(booking.manager_commission, villa.currency)}`
                        : 'another manager'}
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
