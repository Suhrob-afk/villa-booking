import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { fetchVillas } from '../lib/api'
import { useAuth } from '../lib/auth'
import { formatMoney, formatPercent } from '../lib/format'
import { useI18n } from '../lib/i18n'
import { useBackButton } from '../lib/useBackButton'
import type { VillaWithAccess } from '../lib/types'
import { Empty, ErrorState, Loading, ProfileHeader } from '../components/ui'

function VillaCard({ villa, onOpen }: { villa: VillaWithAccess; onOpen: () => void }) {
  const { t, tn } = useI18n()
  return (
    <button type="button" className="card villa-card" onClick={onOpen}>
      <div className="villa-card-head">
        <h3>{villa.name}</h3>
        <span className="badge">{villa.villa_code}</span>
      </div>
      <p className="villa-meta">
        {[villa.location, villa.capacity ? tn('guests', villa.capacity) : null].filter(Boolean).join(' · ') ||
          t('home.noLocation')}
      </p>
      <div className="villa-rates">
        <span className="rate">
          <span className="rate-label">{t('home.rateWeekday')}</span>
          <span className="rate-value">{formatMoney(villa.weekday_price, villa.currency)}</span>
        </span>
        <span className="rate">
          <span className="rate-label">{t('home.rateWeekend')}</span>
          <span className="rate-value">{formatMoney(villa.weekend_price, villa.currency)}</span>
        </span>
        <span className="rate">
          <span className="rate-label">{t('home.rateCommission')}</span>
          <span className="rate-value">{formatPercent(villa.commission_rate)}</span>
        </span>
      </div>
    </button>
  )
}

/**
 * Home is composed from the user's flags rather than from a single role:
 * an owner sees "My Villas", a makler sees "Villas Assigned to Me", and
 * somebody who is both sees both sections stacked -- never merged, and never
 * behind a switcher. Neither flag means a client, who has nothing here yet.
 */
export default function Home() {
  const { user } = useAuth()
  const { t } = useI18n()
  const navigate = useNavigate()
  const [villas, setVillas] = useState<VillaWithAccess[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useBackButton(null)

  const load = useCallback(async () => {
    if (!user?.is_owner && !user?.is_makler) return
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

  const owned = useMemo(() => villas?.filter((v) => v.access === 'owned') ?? [], [villas])
  const assigned = useMemo(() => villas?.filter((v) => v.access === 'managed') ?? [], [villas])

  if (!user) return null

  const isClient = !user.is_owner && !user.is_makler

  return (
    <>
      <ProfileHeader
        action={
          user.is_owner ? (
            <button
              type="button"
              className="icon-button"
              onClick={() => navigate('/villa/new')}
              aria-label={t('home.addVillaAria')}
            >
              +
            </button>
          ) : undefined
        }
      />
      <main className="screen">
        {/* A client: registered, browsing, no villas on either side. */}
        {isClient ? (
          <div className="center-state">
            <h2>{t('home.clientTitle')}</h2>
            <p>{t('home.clientBody')}</p>
          </div>
        ) : (
          <>
            {error && <ErrorState message={error} onRetry={load} />}
            {!error && villas === null && <Loading />}

            {!error && villas !== null && (
              <>
                {user.is_owner && (
                  <>
                    <p className="section-title">{t('home.myVillas')}</p>
                    {owned.length === 0 ? (
                      <Empty title={t('home.noVillasTitle')}>
                        {t('home.noVillasBody')}
                        <div className="button-row">
                          <button type="button" className="button" onClick={() => navigate('/villa/new')}>
                            {t('home.addVilla')}
                          </button>
                        </div>
                      </Empty>
                    ) : (
                      owned.map((villa) => (
                        <VillaCard key={villa.id} villa={villa} onOpen={() => navigate(`/villa/${villa.id}`)} />
                      ))
                    )}
                  </>
                )}

                {user.is_makler && (
                  <>
                    <p className="section-title">{t('home.assignedVillas')}</p>
                    {assigned.length === 0 ? (
                      <Empty title={t('home.noAssignedTitle')}>
                        {t('home.noAssignedBody')}
                        <br />
                        <strong style={{ marginTop: 8, fontSize: 18 }}>{user.oikoz_id}</strong>
                      </Empty>
                    ) : (
                      assigned.map((villa) => (
                        <VillaCard key={villa.id} villa={villa} onOpen={() => navigate(`/villa/${villa.id}`)} />
                      ))
                    )}
                  </>
                )}
              </>
            )}
          </>
        )}
      </main>
    </>
  )
}
