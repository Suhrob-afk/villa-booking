import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { fetchCommissionRows, setCommissionStatus, type CommissionRow } from '../lib/api'
import { useAuth } from '../lib/auth'
import { formatRange } from '../lib/dates'
import { formatMoney } from '../lib/format'
import { notify } from '../lib/telegram'
import { useBackButton } from '../lib/useBackButton'
import { Empty, ErrorState, Loading, TopBar } from '../components/ui'

export default function Commissions() {
  const { user } = useAuth()
  const [rows, setRows] = useState<CommissionRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)

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

  if (!user) return null
  if (error && !rows) return <ErrorState message={error} onRetry={load} />
  if (!rows) return <Loading />

  return (
    <>
      <TopBar title="Commissions" subtitle={user.role === 'owner' ? 'Owed to your managers' : 'Your earnings'} />
      <main className="screen">
        {error && <div className="alert alert-error">{error}</div>}
        {user.role === 'manager' ? (
          <ManagerView rows={rows.filter((row) => row.manager_id === user.id)} />
        ) : (
          <OwnerView rows={rows} busyId={busyId} onTogglePaid={togglePaid} />
        )}
      </main>
    </>
  )
}

// ---------------------------------------------------------------- manager --

function ManagerView({ rows }: { rows: CommissionRow[] }) {
  const navigate = useNavigate()

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
    return <Empty title="No commissions yet">Bookings you create will show up here with what you earned.</Empty>
  }

  return (
    <>
      {totals.map(([currency, bucket]) => (
        <div className="stat-strip" key={currency}>
          <div className="stat">
            <div className="stat-label">Unpaid · {currency}</div>
            <div className="stat-value">{formatMoney(bucket.unpaid, currency)}</div>
          </div>
          <div className="stat">
            <div className="stat-label">Paid · {currency}</div>
            <div className="stat-value">{formatMoney(bucket.paid, currency)}</div>
          </div>
        </div>
      ))}

      <p className="section-title">Bookings</p>
      <div className="list">
        {rows.map((row) => (
          <button type="button" className="row" key={row.id} onClick={() => navigate(`/booking/${row.id}`)}>
            <div className="row-main">
              <div className="row-title">{row.client_name}</div>
              <div className="row-sub">
                {row.villa?.name} · {formatRange(row.check_in, row.check_out)}
              </div>
            </div>
            <div className="row-amount">
              {formatMoney(row.manager_commission, row.villa?.currency ?? 'USD')}
              <div className="row-sub">
                <span className={`badge ${row.commission_status === 'paid' ? 'badge-success' : 'badge-warning'}`}>
                  {row.commission_status}
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

interface OwnerGroup {
  managerId: string
  managerName: string
  currency: string
  rows: CommissionRow[]
  unpaid: number
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
  /** One group per manager per currency: an owner may owe the same person in both USD and UZS. */
  const groups = useMemo(() => {
    const map = new Map<string, OwnerGroup>()
    for (const row of rows) {
      if (!row.manager_id) continue
      const currency = row.villa?.currency ?? 'USD'
      const key = `${row.manager_id}:${currency}`
      const group = map.get(key) ?? {
        managerId: row.manager_id,
        managerName: row.manager?.name ?? 'Manager',
        currency,
        rows: [],
        unpaid: 0,
        paid: 0,
      }
      group.rows.push(row)
      if (row.commission_status === 'paid') group.paid += row.manager_commission
      else group.unpaid += row.manager_commission
      map.set(key, group)
    }
    return [...map.values()].sort((a, b) => b.unpaid - a.unpaid || a.managerName.localeCompare(b.managerName))
  }, [rows])

  if (groups.length === 0) {
    return <Empty title="Nothing owed yet">Once your managers book stays, what you owe them appears here.</Empty>
  }

  return (
    <>
      {groups.map((group) => (
        <section key={`${group.managerId}:${group.currency}`}>
          <div className="group-header">
            <h3>
              {group.managerName} <span className="badge">{group.currency}</span>
            </h3>
            <span className="group-total">{formatMoney(group.unpaid, group.currency)} owed</span>
          </div>
          <div className="list">
            {group.rows.map((row) => (
              <div className="row row-static" key={row.id}>
                <div className="row-main">
                  <div className="row-title">
                    {formatMoney(row.manager_commission, group.currency)} · {row.villa?.name}
                  </div>
                  <div className="row-sub">
                    {row.client_name} · {formatRange(row.check_in, row.check_out)}
                  </div>
                </div>
                <button
                  type="button"
                  className={`toggle ${row.commission_status === 'paid' ? 'paid' : ''}`}
                  disabled={busyId === row.id}
                  onClick={() => onTogglePaid(row)}
                >
                  {row.commission_status === 'paid' ? '✓ Paid' : 'Mark paid'}
                </button>
              </div>
            ))}
          </div>
          {group.paid > 0 && (
            <p className="field-hint" style={{ padding: '6px 4px 0' }}>
              {formatMoney(group.paid, group.currency)} already settled.
            </p>
          )}
        </section>
      ))}
    </>
  )
}
