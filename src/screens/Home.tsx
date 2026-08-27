import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { fetchVillas } from '../lib/api'
import { useAuth } from '../lib/auth'
import { formatMoney, formatPercent } from '../lib/format'
import { useBackButton } from '../lib/useBackButton'
import type { VillaWithAccess } from '../lib/types'
import { Empty, ErrorState, Loading, TopBar } from '../components/ui'

export default function Home() {
  const { user } = useAuth()
  const navigate = useNavigate()
  const [villas, setVillas] = useState<VillaWithAccess[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useBackButton(null)

  const load = useCallback(async () => {
    if (!user) return
    setError(null)
    try {
      setVillas(await fetchVillas(user.id))
    } catch (err) {
      setError((err as Error).message)
    }
  }, [user])

  useEffect(() => {
    void load()
  }, [load])

  if (!user) return null
  const isOwner = user.role === 'owner'

  return (
    <>
      <TopBar
        title="Villas"
        subtitle={`${user.name} · ${isOwner ? 'Owner' : 'Manager'}`}
        action={
          isOwner ? (
            <button
              type="button"
              className="icon-button"
              onClick={() => navigate('/villa/new')}
              aria-label="Add villa"
            >
              +
            </button>
          ) : undefined
        }
      />
      <main className="screen">
        {error && <ErrorState message={error} onRetry={load} />}
        {!error && villas === null && <Loading />}

        {!error && villas?.length === 0 && (
          <Empty title={isOwner ? 'No villas yet' : 'No villas assigned yet'}>
            {isOwner ? (
              <>
                Add your first villa to set its rates and start taking bookings.
                <div className="button-row">
                  <button type="button" className="button" onClick={() => navigate('/villa/new')}>
                    Add villa
                  </button>
                </div>
              </>
            ) : (
              <>
                Ask an owner to add you to a villa using your Telegram ID:
                <br />
                <strong style={{ marginTop: 8 }}>{user.telegram_id}</strong>
              </>
            )}
          </Empty>
        )}

        {villas?.map((villa) => (
          <button type="button" key={villa.id} className="card villa-card" onClick={() => navigate(`/villa/${villa.id}`)}>
            <div className="villa-card-head">
              <h3>{villa.name}</h3>
              <span className={`badge ${villa.access === 'owned' ? 'badge-accent' : ''}`}>
                {villa.access === 'owned' ? 'Owner' : 'Manager'}
              </span>
            </div>
            <p className="villa-meta">
              {[villa.location, villa.capacity ? `${villa.capacity} guests` : null].filter(Boolean).join(' · ') ||
                'No location set'}
            </p>
            <div className="villa-rates">
              <span className="rate">
                <span className="rate-label">Mon–Fri</span>
                <span className="rate-value">{formatMoney(villa.weekday_price, villa.currency)}</span>
              </span>
              <span className="rate">
                <span className="rate-label">Sat–Sun</span>
                <span className="rate-value">{formatMoney(villa.weekend_price, villa.currency)}</span>
              </span>
              <span className="rate">
                <span className="rate-label">Commission</span>
                <span className="rate-value">{formatPercent(villa.commission_rate)}</span>
              </span>
            </div>
          </button>
        ))}
      </main>
    </>
  )
}
