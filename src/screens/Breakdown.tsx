import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { fetchConfirmedBookingsWithVilla, fetchVilla, type BookingWithVilla } from '../lib/api'
import {
  formatRange,
  isWithin,
  nightCount,
  periodLabel,
  periodRange,
  shiftPeriod,
  type PeriodUnit,
} from '../lib/dates'
import { formatMoney } from '../lib/format'
import { useI18n } from '../lib/i18n'
import type { StringKey } from '../lib/strings'
import { useBackButton } from '../lib/useBackButton'
import type { Villa } from '../lib/types'
import { Empty, ErrorState, Loading, TopBar } from '../components/ui'

type Scope = 'villa' | 'all'

const UNITS: { key: PeriodUnit; label: StringKey; empty: StringKey }[] = [
  { key: 'week', label: 'breakdown.unitWeek', empty: 'breakdown.emptyWeek' },
  { key: 'month', label: 'breakdown.unitMonth', empty: 'breakdown.emptyMonth' },
  { key: 'year', label: 'breakdown.unitYear', empty: 'breakdown.emptyYear' },
]

interface CurrencyTotals {
  currency: string
  payout: number
  gross: number
}

/**
 * Nights and money for a period, at one villa or across all of them.
 *
 * A booking is attributed whole to the period containing its check-in — a stay
 * running across a month boundary counts entirely in the month it started, and
 * is never split. Simple to reason about, and it matches how the nights are
 * listed underneath.
 */
export default function Breakdown() {
  const { villaId } = useParams<{ villaId: string }>()
  const navigate = useNavigate()
  const { lang, t } = useI18n()

  const [villa, setVilla] = useState<Villa | null>(null)
  const [bookings, setBookings] = useState<BookingWithVilla[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  const [unit, setUnit] = useState<PeriodUnit>('month')
  const [anchor, setAnchor] = useState(() => new Date())
  const [scope, setScope] = useState<Scope>('villa')

  const goBack = useCallback(() => navigate(`/villa/${villaId}`), [navigate, villaId])
  useBackButton(goBack)

  const load = useCallback(async () => {
    if (!villaId) return
    setError(null)
    try {
      const [villaRow, bookingRows] = await Promise.all([
        fetchVilla(villaId),
        fetchConfirmedBookingsWithVilla(),
      ])
      setVilla(villaRow)
      setBookings(bookingRows)
    } catch (err) {
      setError((err as Error).message)
    }
  }, [villaId])

  useEffect(() => {
    void load()
  }, [load])

  const range = useMemo(() => periodRange(anchor, unit), [anchor, unit])

  const included = useMemo(() => {
    if (!bookings) return []
    return bookings
      .filter((booking) => (scope === 'villa' ? booking.villa_id === villaId : true))
      .filter((booking) => isWithin(booking.check_in, range))
      .sort((a, b) => a.check_in.localeCompare(b.check_in))
  }, [bookings, scope, villaId, range])

  const nights = useMemo(
    () => included.reduce((sum, booking) => sum + nightCount(booking.check_in, booking.check_out), 0),
    [included],
  )

  /**
   * Villas can be priced in different currencies, so money is grouped rather
   * than summed — a blended USD+UZS figure would be meaningless.
   */
  const totals = useMemo(() => {
    const map = new Map<string, CurrencyTotals>()
    for (const booking of included) {
      const currency = booking.villa?.currency ?? 'USD'
      const entry = map.get(currency) ?? { currency, payout: 0, gross: 0 }
      entry.payout += booking.owner_payout
      entry.gross += booking.total_price
      map.set(currency, entry)
    }
    return [...map.values()].sort((a, b) => a.currency.localeCompare(b.currency))
  }, [included])

  if (error) return <ErrorState message={error} onRetry={load} />
  if (!bookings || !villa) return <Loading />

  return (
    <>
      <TopBar
        title={t('breakdown.title')}
        subtitle={scope === 'villa' ? villa.name : t('breakdown.allVillas')}
        onBack={goBack}
      />
      <main className="screen">
        <div className="segmented" role="tablist">
          {UNITS.map(({ key, label }) => (
            <button
              key={key}
              type="button"
              className={`segmented-item${unit === key ? ' segmented-item-active' : ''}`}
              onClick={() => setUnit(key)}
            >
              {t(label)}
            </button>
          ))}
        </div>

        <div className="period-nav">
          <button
            type="button"
            className="icon-button"
            onClick={() => setAnchor((a) => shiftPeriod(a, unit, -1))}
            aria-label={t('breakdown.prevPeriod')}
          >
            ‹
          </button>
          <span className="period-label">{periodLabel(anchor, unit, lang)}</span>
          <button
            type="button"
            className="icon-button"
            onClick={() => setAnchor((a) => shiftPeriod(a, unit, 1))}
            aria-label={t('breakdown.nextPeriod')}
          >
            ›
          </button>
        </div>

        <div className="segmented" role="tablist" style={{ marginBottom: 16 }}>
          <button
            type="button"
            className={`segmented-item${scope === 'villa' ? ' segmented-item-active' : ''}`}
            onClick={() => setScope('villa')}
          >
            {t('breakdown.thisVilla')}
          </button>
          <button
            type="button"
            className={`segmented-item${scope === 'all' ? ' segmented-item-active' : ''}`}
            onClick={() => setScope('all')}
          >
            {t('breakdown.allVillas')}
          </button>
        </div>

        <div className="stat-strip">
          <div className="stat">
            <div className="stat-label">{t('breakdown.nightsBooked')}</div>
            <div className="stat-value">{nights}</div>
          </div>
          <div className="stat">
            <div className="stat-label">{t('breakdown.bookings')}</div>
            <div className="stat-value">{included.length}</div>
          </div>
        </div>

        {totals.length === 0 ? (
          <Empty title={t('breakdown.emptyTitle')}>
            {t(UNITS.find((u) => u.key === unit)!.empty)}
          </Empty>
        ) : (
          totals.map((total) => (
            <div className="card card-pad" key={total.currency} style={{ marginBottom: 12 }}>
              <div className="group-header" style={{ margin: '0 0 6px' }}>
                <h3>{total.currency}</h3>
              </div>
              <dl className="summary">
                <div className="summary-row total">
                  <dt>{t('breakdown.payout')}</dt>
                  <dd>{formatMoney(total.payout, total.currency)}</dd>
                </div>
                <div className="summary-row muted">
                  <dt>{t('breakdown.gross')}</dt>
                  <dd>{formatMoney(total.gross, total.currency)}</dd>
                </div>
              </dl>
            </div>
          ))
        )}

        {included.length > 0 && (
          <>
            <p className="section-title">{t('breakdown.included')}</p>
            <div className="list">
              {included.map((booking) => (
                <button
                  type="button"
                  className="row"
                  key={booking.id}
                  onClick={() => navigate(`/booking/${booking.id}`)}
                >
                  <div className="row-main">
                    <div className="row-title">
                      {scope === 'all' ? `${booking.villa?.name} · ${booking.client_name}` : booking.client_name}
                      {!booking.deposit_paid && (
                        <span className="badge badge-pending"> {t('villa.depositPending')}</span>
                      )}
                    </div>
                    <div className="row-sub">{formatRange(booking.check_in, booking.check_out, lang)}</div>
                  </div>
                  <div className="row-amount">
                    {formatMoney(booking.total_price, booking.villa?.currency ?? 'USD')}
                    <div className="row-sub">
                      {t('villa.rowPayout', {
                        amount: formatMoney(booking.owner_payout, booking.villa?.currency ?? 'USD'),
                      })}
                    </div>
                  </div>
                </button>
              ))}
            </div>
          </>
        )}
      </main>
    </>
  )
}
