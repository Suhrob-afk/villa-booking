/**
 * The owner's Overview: how much was booked, how much came in, and when.
 *
 * Money is never summed across currencies. An owner can hold a UZS villa and a
 * USD villa at once, so every figure here is grouped per currency exactly as
 * Breakdown and Commissions already do it -- a blended total would be a made-up
 * number.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { fetchDashboardBookings, type DashboardBooking } from '../lib/api'
import {
  addMonths,
  isWithin,
  nightsBetween,
  periodLabel,
  periodRange,
  shiftPeriod,
  startOfMonth,
  toISODate,
  weekdayLabels,
  type PeriodUnit,
} from '../lib/dates'
import { currencyCode, formatMoney } from '../lib/format'
import { useI18n } from '../lib/i18n'
import { MONTHS_SHORT, type StringKey } from '../lib/strings'
import { Empty, ErrorState, Loading } from '../components/ui'

const UNITS: { key: PeriodUnit; label: StringKey }[] = [
  { key: 'week', label: 'breakdown.unitWeek' },
  { key: 'month', label: 'breakdown.unitMonth' },
  { key: 'year', label: 'breakdown.unitYear' },
]

const ALL = 'all'
/** How far the monthly charts look back, regardless of the period selector. */
const MONTHS_BACK = 12

interface MoneyTotals {
  currency: string
  sales: number
  profit: number
  perVilla: { id: string; name: string; sales: number; profit: number }[]
}

interface MonthBar {
  key: string
  label: string
  sales: number
  profit: number
}

export default function Overview() {
  const { lang, t, tn } = useI18n()
  const [bookings, setBookings] = useState<DashboardBooking[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [unit, setUnit] = useState<PeriodUnit>('month')
  const [anchor, setAnchor] = useState(() => new Date())
  const [villaId, setVillaId] = useState<string>(ALL)

  const load = useCallback(async () => {
    setError(null)
    try {
      setBookings(await fetchDashboardBookings())
    } catch (err) {
      setError((err as Error).message)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  /** Taken from the bookings themselves, so archived villas still appear. */
  const villas = useMemo(() => {
    const map = new Map<string, { id: string; name: string }>()
    for (const booking of bookings ?? []) {
      if (booking.villa) map.set(booking.villa.id, { id: booking.villa.id, name: booking.villa.name })
    }
    return [...map.values()].sort((a, b) => a.name.localeCompare(b.name))
  }, [bookings])

  const scoped = useMemo(
    () => (bookings ?? []).filter((b) => villaId === ALL || b.villa_id === villaId),
    [bookings, villaId],
  )

  const range = useMemo(() => periodRange(anchor, unit), [anchor, unit])
  const inPeriod = useMemo(() => scoped.filter((b) => isWithin(b.check_in, range)), [scoped, range])

  const successful = useMemo(() => inPeriod.filter((b) => b.status === 'confirmed').length, [inPeriod])
  const cancelled = useMemo(() => inPeriod.filter((b) => b.status === 'cancelled').length, [inPeriod])

  /** Only confirmed bookings are money; a cancellation sold nothing. */
  const money = useMemo(() => {
    const map = new Map<string, MoneyTotals & { villaMap: Map<string, { id: string; name: string; sales: number; profit: number }> }>()
    for (const booking of inPeriod) {
      if (booking.status !== 'confirmed') continue
      const currency = currencyCode(booking.currency)
      const entry =
        map.get(currency) ?? { currency, sales: 0, profit: 0, perVilla: [], villaMap: new Map() }
      entry.sales += booking.total_price
      entry.profit += booking.owner_payout
      const id = booking.villa_id
      const villa = entry.villaMap.get(id) ?? { id, name: booking.villa?.name ?? '—', sales: 0, profit: 0 }
      villa.sales += booking.total_price
      villa.profit += booking.owner_payout
      entry.villaMap.set(id, villa)
      map.set(currency, entry)
    }
    return [...map.values()]
      .map((entry) => ({
        currency: entry.currency,
        sales: entry.sales,
        profit: entry.profit,
        perVilla: [...entry.villaMap.values()].sort((a, b) => b.sales - a.sales),
      }))
      .sort((a, b) => a.currency.localeCompare(b.currency))
  }, [inPeriod])

  /**
   * A fixed twelve-month window, not the selected period: "per month" only
   * means anything across several, and a one-bar chart for a week would not.
   */
  const monthly = useMemo(() => {
    const start = startOfMonth(new Date())
    const keys: MonthBar[] = []
    for (let i = MONTHS_BACK - 1; i >= 0; i--) {
      const month = addMonths(start, -i)
      keys.push({
        key: toISODate(month).slice(0, 7),
        label: MONTHS_SHORT[lang][month.getMonth()],
        sales: 0,
        profit: 0,
      })
    }

    const byCurrency = new Map<string, MonthBar[]>()
    for (const booking of scoped) {
      if (booking.status !== 'confirmed') continue
      const key = booking.check_in.slice(0, 7)
      const currency = currencyCode(booking.currency)
      const bars = byCurrency.get(currency) ?? keys.map((bar) => ({ ...bar }))
      const bar = bars.find((candidate) => candidate.key === key)
      if (bar) {
        bar.sales += booking.total_price
        bar.profit += booking.owner_payout
      }
      byCurrency.set(currency, bars)
    }
    return [...byCurrency.entries()]
      .map(([currency, bars]) => ({ currency, bars }))
      .sort((a, b) => a.currency.localeCompare(b.currency))
  }, [scoped, lang])

  /** All time on purpose: a busiest-day ranking over one week says nothing. */
  const busiest = useMemo(() => {
    const labels = weekdayLabels(lang)
    const nights = [0, 0, 0, 0, 0, 0, 0]
    for (const booking of scoped) {
      if (booking.status !== 'confirmed') continue
      for (const night of nightsBetween(booking.check_in, booking.check_out)) {
        nights[(night.getDay() + 6) % 7] += 1 // Monday-first, like the calendar
      }
    }
    const peak = Math.max(...nights)
    return {
      peak,
      rows: nights
        .map((count, index) => ({ label: labels[index], count }))
        .sort((a, b) => b.count - a.count),
    }
  }, [scoped, lang])

  if (error && !bookings) return <ErrorState message={error} onRetry={load} />
  if (!bookings) return <Loading />

  return (
    <>
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

      {/* One villa needs no filter. */}
      {villas.length > 1 && (
        <div className="field">
          <label htmlFor="villa-filter">{t('dashboard.villaFilter')}</label>
          <select id="villa-filter" value={villaId} onChange={(e) => setVillaId(e.target.value)}>
            <option value={ALL}>{t('dashboard.allVillas')}</option>
            {villas.map((villa) => (
              <option key={villa.id} value={villa.id}>
                {villa.name}
              </option>
            ))}
          </select>
        </div>
      )}

      <div className="stat-strip">
        <div className="stat">
          <div className="stat-label">{t('dashboard.successful')}</div>
          <div className="stat-value">{successful}</div>
        </div>
        <div className="stat">
          <div className="stat-label">{t('dashboard.cancelled')}</div>
          <div className="stat-value">{cancelled}</div>
        </div>
      </div>

      {money.length === 0 ? (
        <Empty title={t('breakdown.emptyTitle')}>{t('dashboard.noData')}</Empty>
      ) : (
        money.map((total) => (
          <div className="card card-pad" key={total.currency} style={{ marginBottom: 12 }}>
            <div className="group-header" style={{ margin: '0 0 6px' }}>
              <h3>{total.currency}</h3>
            </div>
            <dl className="summary">
              <div className="summary-row total">
                <dt>{t('dashboard.sales')}</dt>
                <dd>{formatMoney(total.sales, total.currency)}</dd>
              </div>
              <div className="summary-row total">
                <dt>{t('dashboard.profit')}</dt>
                <dd>{formatMoney(total.profit, total.currency)}</dd>
              </div>
              {/* Per villa only when there is more than one to split. */}
              {total.perVilla.length > 1 &&
                total.perVilla.map((villa) => (
                  <div className="summary-row muted" key={villa.id}>
                    <dt>{villa.name}</dt>
                    <dd>
                      {formatMoney(villa.sales, total.currency)} · {formatMoney(villa.profit, total.currency)}
                    </dd>
                  </div>
                ))}
            </dl>
          </div>
        ))
      )}

      {monthly.length > 0 && (
        <>
          <p className="section-title">{t('dashboard.byMonth')}</p>
          {monthly.map(({ currency, bars }) => (
            <div className="card card-pad" key={currency} style={{ marginBottom: 12 }}>
              <div className="group-header" style={{ margin: '0 0 10px' }}>
                <h3>{currency}</h3>
              </div>
              <MonthChart title={t('dashboard.salesByMonth')} bars={bars} pick={(b) => b.sales} currency={currency} />
              <div style={{ marginTop: 14 }}>
                <MonthChart
                  title={t('dashboard.profitByMonth')}
                  bars={bars}
                  pick={(b) => b.profit}
                  currency={currency}
                />
              </div>
            </div>
          ))}
        </>
      )}

      <p className="section-title">{t('dashboard.busiestDays')}</p>
      <div className="card card-pad">
        {busiest.peak === 0 ? (
          <p className="field-hint" style={{ margin: 0 }}>
            {t('dashboard.noNights')}
          </p>
        ) : (
          <>
            {busiest.rows.map((row) => (
              <div className="rank-row" key={row.label}>
                <span className="rank-label">{row.label}</span>
                <span className="rank-track">
                  <span
                    className="rank-fill"
                    style={{ width: `${Math.round((row.count / busiest.peak) * 100)}%` }}
                  />
                </span>
                <span className="rank-value">{tn('nights', row.count)}</span>
              </div>
            ))}
            <p className="field-hint" style={{ marginBottom: 0 }}>
              {t('dashboard.busiestAllTime')}
            </p>
          </>
        )}
      </div>
    </>
  )
}

/** Twelve bars, scaled to the tallest. Pure CSS: no chart library involved. */
function MonthChart({
  title,
  bars,
  pick,
  currency,
}: {
  title: string
  bars: MonthBar[]
  pick: (bar: MonthBar) => number
  currency: string
}) {
  const peak = Math.max(...bars.map(pick), 0)

  return (
    <div>
      <p className="field-hint" style={{ marginTop: 0, marginBottom: 8 }}>
        {title}
      </p>
      <div className="chart">
        {bars.map((bar) => {
          const value = pick(bar)
          const height = peak > 0 ? Math.max((value / peak) * 100, value > 0 ? 4 : 0) : 0
          return (
            <span
              className={`chart-col${value > 0 ? '' : ' is-empty'}`}
              key={bar.key}
              title={`${bar.label}: ${formatMoney(value, currency)}`}
            >
              <span style={{ height: `${height}%` }} />
            </span>
          )
        })}
      </div>
      <div className="chart-labels">
        {bars.map((bar) => (
          <span key={bar.key}>{bar.label}</span>
        ))}
      </div>
    </div>
  )
}
