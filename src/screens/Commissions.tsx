import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { fetchCommissionRows, setCommissionStatus, setDepositPaid, type CommissionRow } from '../lib/api'
import { useAuth } from '../lib/auth'
import { formatRange } from '../lib/dates'
import { formatMoney } from '../lib/format'
import { useI18n } from '../lib/i18n'
import { notify } from '../lib/telegram'
import { useBackButton } from '../lib/useBackButton'
import { Empty, ErrorState, Loading, TopBar } from '../components/ui'

type ViewAs = 'owner' | 'makler' | 'deposits'

export default function Commissions() {
  const { user } = useAuth()
  const { t } = useI18n()
  const [rows, setRows] = useState<CommissionRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [viewAs, setViewAs] = useState<ViewAs>('owner')

  useBackButton(null)

  const load = useCallback(async () => {
    setError(null)
    try {
      setRows(await fetchCommissionRows())
    } catch (err) {
      setError((err as Error).message)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const togglePaid = useCallback(async (row: CommissionRow) => {
    setBusyId(row.id)
    setError(null)
    try {
      const next = row.commission_status === 'paid' ? 'unpaid' : 'paid'
      const updated = await setCommissionStatus(row.id, next)
      setRows((current) =>
        current?.map((r) => (r.id === row.id ? { ...r, commission_status: updated.commission_status } : r)) ?? null,
      )
      notify('success')
    } catch (err) {
      notify('error')
      setError((err as Error).message)
    } finally {
      setBusyId(null)
    }
  }, [])

  const markDepositPaid = useCallback(async (row: CommissionRow) => {
    setBusyId(row.id)
    setError(null)
    try {
      const updated = await setDepositPaid(row.id, !row.deposit_paid)
      setRows((current) =>
        current?.map((r) => (r.id === row.id ? { ...r, deposit_paid: updated.deposit_paid } : r)) ?? null,
      )
      notify('success')
    } catch (err) {
      notify('error')
      setError((err as Error).message)
    } finally {
      setBusyId(null)
    }
  }, [])

  if (!user) return null
  const both = user.is_owner && user.is_makler
  const effectiveView: ViewAs =
    viewAs === 'deposits' ? 'deposits' : both ? viewAs : user.is_owner ? 'owner' : 'makler'

  if (error && !rows) return <ErrorState message={error} onRetry={load} />
  if (!rows) return <Loading />

  return (
    <>
      <TopBar
        title={t('commissions.title')}
        subtitle={
          effectiveView === 'owner' ? t('commissions.subtitleOwner') : t('commissions.subtitleMakler')
        }
      />
      <main className="screen">
        {both && (
          <div className="segmented" role="tablist" style={{ marginBottom: 14 }}>
            <button
              type="button"
              className={`segmented-item${effectiveView === 'owner' ? ' segmented-item-active' : ''}`}
              onClick={() => setViewAs('owner')}
            >
              {t('commissions.asOwner')}
            </button>
            <button
              type="button"
              className={`segmented-item${effectiveView === 'makler' ? ' segmented-item-active' : ''}`}
              onClick={() => setViewAs('makler')}
            >
              {t('commissions.asMakler')}
            </button>
          </div>
        )}

        <div className="segmented" role="tablist" style={{ marginBottom: 14 }}>
          <button
            type="button"
            className={`segmented-item${effectiveView !== 'deposits' ? ' segmented-item-active' : ''}`}
            onClick={() => setViewAs(user.is_owner ? 'owner' : 'makler')}
          >
            {t('commissions.tabCommission')}
          </button>
          <button
            type="button"
            className={`segmented-item${effectiveView === 'deposits' ? ' segmented-item-active' : ''}`}
            onClick={() => setViewAs('deposits')}
          >
            {t('commissions.tabDeposits')}
          </button>
        </div>

        {error && <div className="alert alert-error">{error}</div>}
        {effectiveView === 'deposits' ? (
          <PendingDeposits
            rows={rows.filter((row) => !row.deposit_paid)}
            canToggle={user.is_owner}
            busyId={busyId}
            onMarkPaid={markDepositPaid}
          />
        ) : effectiveView === 'makler' ? (
          <MaklerView rows={rows.filter((row) => row.manager_id === user.id)} />
        ) : (
          <OwnerView rows={rows} busyId={busyId} onTogglePaid={togglePaid} />
        )}
      </main>
    </>
  )
}

// ----------------------------------------------------------------- makler --

function MaklerView({ rows }: { rows: CommissionRow[] }) {
  const navigate = useNavigate()
  const { lang, t } = useI18n()

  /** Money never crosses currencies — every total is per currency. */
  const totals = useMemo(() => {
    const map = new Map<string, { unpaid: number; paid: number }>()
    for (const row of rows) {
      const currency = row.villa?.currency ?? 'USD'
      const bucket = map.get(currency) ?? { unpaid: 0, paid: 0 }
      if (row.commission_status === 'paid') bucket.paid += row.manager_commission
      else bucket.unpaid += row.manager_commission
      map.set(currency, bucket)
    }
    return [...map.entries()]
  }, [rows])

  if (rows.length === 0) {
    return <Empty title={t('commissions.maklerEmptyTitle')}>{t('commissions.maklerEmptyBody')}</Empty>
  }

  return (
    <>
      {totals.map(([currency, bucket]) => (
        <div className="stat-strip" key={currency}>
          <div className="stat">
            <div className="stat-label">{t('commissions.statUnpaid', { currency })}</div>
            <div className="stat-value">{formatMoney(bucket.unpaid, currency)}</div>
          </div>
          <div className="stat">
            <div className="stat-label">{t('commissions.statPaid', { currency })}</div>
            <div className="stat-value">{formatMoney(bucket.paid, currency)}</div>
          </div>
        </div>
      ))}

      <p className="section-title">{t('commissions.bookings')}</p>
      <div className="list">
        {rows.map((row) => (
          <button type="button" className="row" key={row.id} onClick={() => navigate(`/booking/${row.id}`)}>
            <div className="row-main">
              <div className="row-title">{row.client_name}</div>
              <div className="row-sub">
                {row.villa?.name} · {formatRange(row.check_in, row.check_out, lang)}
              </div>
            </div>
            <div className="row-amount">
              {formatMoney(row.manager_commission, row.villa?.currency ?? 'USD')}
              <div className="row-sub">
                <span className={`badge ${row.commission_status === 'paid' ? 'badge-success' : 'badge-warning'}`}>
                  {row.commission_status === 'paid' ? t('common.paid') : t('common.unpaid')}
                </span>
              </div>
            </div>
          </button>
        ))}
      </div>
    </>
  )
}

// ------------------------------------------------------------------ owner --

interface OwnerTotal {
  maklerId: string
  maklerName: string
  currency: string
  owed: number
  paid: number
}

function OwnerView({
  rows,
  busyId,
  onTogglePaid,
}: {
  rows: CommissionRow[]
  busyId: string | null
  onTogglePaid: (row: CommissionRow) => void
}) {
  const { lang, t } = useI18n()
  /**
   * One running total per makler per currency: an owner may owe the same
   * person in both USD and UZS, and those must never be added together.
   */
  const totals = useMemo(() => {
    const map = new Map<string, OwnerTotal>()
    for (const row of rows) {
      if (!row.manager_id) continue
      const currency = row.villa?.currency ?? 'USD'
      const key = `${row.manager_id}:${currency}`
      const entry = map.get(key) ?? {
        maklerId: row.manager_id,
        maklerName: row.manager?.name ?? t('commissions.maklerFallback'),
        currency,
        owed: 0,
        paid: 0,
      }
      if (row.commission_status === 'paid') entry.paid += row.manager_commission
      else entry.owed += row.manager_commission
      map.set(key, entry)
    }
    return [...map.values()].sort((a, b) => b.owed - a.owed || a.maklerName.localeCompare(b.maklerName))
  }, [rows])

  /** The working list: everything still unpaid, soonest stay first. */
  const open = useMemo(
    () =>
      rows
        .filter((row) => row.commission_status === 'unpaid')
        .sort((a, b) => a.check_in.localeCompare(b.check_in)),
    [rows],
  )

  const settled = useMemo(() => rows.filter((row) => row.commission_status === 'paid'), [rows])

  if (rows.length === 0) {
    return <Empty title={t('commissions.ownerEmptyTitle')}>{t('commissions.ownerEmptyBody')}</Empty>
  }

  return (
    <>
      <p className="section-title">{t('commissions.owedPerMakler')}</p>
      <div className="list">
        {totals.map((total) => (
          <div className="row row-static" key={`${total.maklerId}:${total.currency}`}>
            <div className="row-main">
              <div className="row-title">{total.maklerName}</div>
              <div className="row-sub">
                {total.paid > 0
                  ? t('commissions.alreadySettled', {
                      amount: formatMoney(total.paid, total.currency),
                    })
                  : t('commissions.nothingSettled')}
              </div>
            </div>
            <div className="row-amount">
              {formatMoney(total.owed, total.currency)}
              <div className="row-sub">{total.currency}</div>
            </div>
          </div>
        ))}
      </div>

      <p className="section-title">{t('commissions.openCommission')}</p>
      {open.length === 0 ? (
        <Empty title={t('commissions.allSettledTitle')}>{t('commissions.allSettledBody')}</Empty>
      ) : (
        <div className="list">
          {open.map((row) => (
            <div className="row row-static" key={row.id}>
              <div className="row-main">
                <div className="row-title">{row.manager?.name ?? t('commissions.maklerFallback')}</div>
                <div className="row-sub">
                  {row.villa?.name} · {formatRange(row.check_in, row.check_out, lang)}
                </div>
                <div className="row-sub">
                  {formatMoney(row.manager_commission, row.villa?.currency ?? 'USD')}
                </div>
              </div>
              <button
                type="button"
                className="toggle"
                disabled={busyId === row.id}
                onClick={() => onTogglePaid(row)}
              >
                {t('commissions.markPaid')}
              </button>
            </div>
          ))}
        </div>
      )}

      {settled.length > 0 && (
        <>
          <p className="section-title">{t('commissions.settled')}</p>
          <div className="list">
            {settled.map((row) => (
              <div className="row row-static" key={row.id}>
                <div className="row-main">
                  <div className="row-title">{row.manager?.name ?? t('commissions.maklerFallback')}</div>
                  <div className="row-sub">
                    {row.villa?.name} · {formatRange(row.check_in, row.check_out, lang)}
                  </div>
                </div>
                <button
                  type="button"
                  className="toggle paid"
                  disabled={busyId === row.id}
                  onClick={() => onTogglePaid(row)}
                >
                  ✓ {formatMoney(row.manager_commission, row.villa?.currency ?? 'USD')}
                </button>
              </div>
            ))}
          </div>
        </>
      )}
    </>
  )
}

// -------------------------------------------------------------- deposits --

/**
 * Deposits the CLIENT still owes. Deliberately separate from commission
 * settlement above: one is money coming in, the other is money going out.
 */
function PendingDeposits({
  rows,
  canToggle,
  busyId,
  onMarkPaid,
}: {
  rows: CommissionRow[]
  canToggle: boolean
  busyId: string | null
  onMarkPaid: (row: CommissionRow) => void
}) {
  const { lang, t } = useI18n()
  const totals = useMemo(() => {
    const map = new Map<string, number>()
    for (const row of rows) {
      const currency = row.villa?.currency ?? 'USD'
      map.set(currency, (map.get(currency) ?? 0) + row.deposit_amount)
    }
    return [...map.entries()]
  }, [rows])

  if (rows.length === 0) {
    return <Empty title={t('commissions.noDepositsTitle')}>{t('commissions.noDepositsBody')}</Empty>
  }

  return (
    <>
      {totals.map(([currency, amount]) => (
        <div className="stat-strip" key={currency}>
          <div className="stat">
            <div className="stat-label">{t('commissions.statOutstanding', { currency })}</div>
            <div className="stat-value">{formatMoney(amount, currency)}</div>
          </div>
          <div className="stat">
            <div className="stat-label">{t('commissions.bookings')}</div>
            <div className="stat-value">{rows.filter((r) => (r.villa?.currency ?? 'USD') === currency).length}</div>
          </div>
        </div>
      ))}

      <p className="section-title">{t('commissions.awaitingDeposit')}</p>
      <div className="list">
        {rows.map((row) => (
          <div className="row row-static" key={row.id}>
            <div className="row-main">
              <div className="row-title">{row.client_name}</div>
              <div className="row-sub">
                {row.villa?.name} · {formatRange(row.check_in, row.check_out, lang)}
              </div>
              <div className="row-sub">
                {t('commissions.amountDue', {
                  amount: formatMoney(row.deposit_amount, row.villa?.currency ?? 'USD'),
                })}
              </div>
            </div>
            {canToggle && (
              <button
                type="button"
                className="toggle"
                disabled={busyId === row.id}
                onClick={() => onMarkPaid(row)}
              >
                {t('commissions.markReceived')}
              </button>
            )}
          </div>
        ))}
      </div>
    </>
  )
}
