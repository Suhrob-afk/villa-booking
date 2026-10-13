import { Share2 } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState, type MouseEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { fetchArchivedVillas, fetchVillas, fetchVillasMissingCardName, setVillaArchived } from '../lib/api'
import { useAuth } from '../lib/auth'
import { formatMoney, formatPercent } from '../lib/format'
import { useI18n } from '../lib/i18n'
import { shareBookingLink } from '../lib/share'
import { isWritable, useMySubscription } from '../lib/subscription'
import { notify } from '../lib/telegram'
import { useBackButton } from '../lib/useBackButton'
import type { Villa, VillaWithAccess } from '../lib/types'
import { ReadOnlyNotice, SubscriptionBanner } from '../components/Subscription'
import { Empty, ErrorState, Loading, ProfileHeader, Toast } from '../components/ui'

/**
 * A villa on Home.
 *
 * Owners see the two nightly prices and a "Booking link" button under them,
 * which shares the villa's public link. Maklers see the commission column
 * instead -- it is their earning rate -- and no button.
 *
 * The owner card is a container rather than one big button, because a button
 * cannot contain another. The share button also stops propagation, so a tap
 * on it never opens the villa. It sits in its own full-width row: at 360px a
 * UZS card has no room for it beside the two prices.
 *
 * An owner whose payout card has no name yet (a card saved before 0026) gets
 * a quiet "Payout setup incomplete" nudge on its own line above that button,
 * leading to Villa Setup. Nothing is blocked; the villa works as before.
 */
function VillaCard({
  villa,
  onOpen,
  onShare,
  onFinishPayout,
}: {
  villa: VillaWithAccess
  onOpen: () => void
  onShare?: () => void
  /** Owner only, and only when the card has no name: opens Villa Setup. */
  onFinishPayout?: () => void
}) {
  const { t, tn } = useI18n()

  const body = (
    <>
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
        {!onShare && (
          <span className="rate">
            <span className="rate-label">{t('home.rateCommission')}</span>
            <span className="rate-value">{formatPercent(villa.commission_rate)}</span>
          </span>
        )}
      </div>
    </>
  )

  if (!onShare) {
    return (
      <button type="button" className="card villa-card" onClick={onOpen}>
        {body}
      </button>
    )
  }

  return (
    <div className="card villa-card-owned">
      <button type="button" className="villa-card villa-card-open" onClick={onOpen}>
        {body}
      </button>
      <div className="villa-card-actions">
        {onFinishPayout && (
          <button
            type="button"
            className="villa-card-nudge"
            onClick={(event: MouseEvent) => {
              event.stopPropagation()
              onFinishPayout()
            }}
          >
            {t('home.payoutIncomplete')}
            <span aria-hidden="true">›</span>
          </button>
        )}
        <button
          type="button"
          className="button villa-card-link"
          onClick={(event: MouseEvent) => {
            event.stopPropagation()
            onShare()
          }}
        >
          <Share2 size={18} strokeWidth={2} aria-hidden="true" />
          {t('home.bookingLink')}
        </button>
      </div>
    </div>
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
  const [archived, setArchived] = useState<Villa[]>([])
  const [showArchived, setShowArchived] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  /** The share confirmation; `id` restarts the timer when the same text repeats. */
  const [toast, setToast] = useState<{ id: number; text: string } | null>(null)
  const hideToast = useCallback(() => setToast(null), [])
  const subscription = useMySubscription()
  /** Owned villas whose payout card still needs the name on it. */
  const [missingCardName, setMissingCardName] = useState<Set<string>>(new Set())
  /** Tapped "add a villa" without a subscription: explain instead of opening the form. */
  const [showCreateNotice, setShowCreateNotice] = useState(false)

  useBackButton(null)

  const load = useCallback(async () => {
    if (!user?.is_owner && !user?.is_makler) return
    setError(null)
    try {
      const [active, archivedRows] = await Promise.all([
        fetchVillas(user.id),
        // Only an owner can have archived any; a makler's roster is theirs.
        user.is_owner ? fetchArchivedVillas() : Promise.resolve([] as Villa[]),
      ])
      setVillas(active)
      setArchived(archivedRows)
    } catch (err) {
      setError((err as Error).message)
    }
    // Only a nudge: if it cannot be loaded (offline, or before 0026), there is
    // simply no badge.
    if (user.is_owner) {
      fetchVillasMissingCardName()
        .then((ids) => setMissingCardName(new Set(ids)))
        .catch(() => setMissingCardName(new Set()))
    }
  }, [user])

  useEffect(() => {
    void load()
  }, [load])

  const owned = useMemo(() => villas?.filter((v) => v.access === 'owned') ?? [], [villas])
  const assigned = useMemo(() => villas?.filter((v) => v.access === 'managed') ?? [], [villas])

  async function shareVilla(villa: Villa) {
    const result = await shareBookingLink(villa)
    if (result === 'opened') return // Telegram's own picker is the feedback.
    notify(result === 'copied' ? 'success' : 'error')
    setToast({ id: Date.now(), text: result === 'copied' ? t('home.linkCopied') : t('home.linkCopyFailed') })
  }

  if (!user) return null

  const isClient = !user.is_owner && !user.is_makler

  // Creating a villa follows the creator's own subscription. Not known yet
  // (null) counts as allowed: the database has the final word.
  const canCreate = subscription.state === null || isWritable(subscription.state)
  // Editing their villas follows it too, so only somebody who owns villas sees
  // the banner -- a makler with none of their own never does.
  const ownsVillas = owned.length > 0 || archived.length > 0

  function addVilla() {
    if (canCreate) navigate('/villa/new')
    else setShowCreateNotice(true)
  }

  return (
    <>
      <ProfileHeader
        action={
          user.is_owner ? (
            <button
              type="button"
              className="icon-button"
              onClick={addVilla}
              aria-label={t('home.addVillaAria')}
            >
              +
            </button>
          ) : undefined
        }
      />
      <main className="screen">
        {/* A client: registered, no villas on either side. */}
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
                {ownsVillas && <SubscriptionBanner />}
                {showCreateNotice && !canCreate && <ReadOnlyNotice access="create" withButton={!ownsVillas} />}

                {user.is_owner && (
                  <>
                    <p className="section-title">{t('home.myVillas')}</p>
                    {owned.length === 0 ? (
                      <Empty title={t('home.noVillasTitle')}>
                        {t('home.noVillasBody')}
                        <div className="button-row">
                          <button type="button" className="button" onClick={addVilla}>
                            {t('home.addVilla')}
                          </button>
                        </div>
                      </Empty>
                    ) : (
                      owned.map((villa) => (
                        <VillaCard
                          key={villa.id}
                          villa={villa}
                          onOpen={() => navigate(`/villa/${villa.id}`)}
                          // Owned means owner_id is the signed-in user, the same
                          // test is_villa_owner() makes. Makler cards get none.
                          onShare={() => void shareVilla(villa)}
                          onFinishPayout={
                            missingCardName.has(villa.id) ? () => navigate(`/villa/${villa.id}/setup`) : undefined
                          }
                        />
                      ))
                    )}
                  </>
                )}

                {user.is_owner && archived.length > 0 && (
                  <>
                    <button
                      type="button"
                      className="archived-toggle"
                      aria-expanded={showArchived}
                      onClick={() => setShowArchived((current) => !current)}
                    >
                      {t('home.archivedToggle', { count: archived.length })}
                      <span aria-hidden="true">{showArchived ? '\u2039' : '\u203a'}</span>
                    </button>
                    {showArchived && (
                      <div className="list">
                        {archived.map((villa) => (
                          <div className="row row-static" key={villa.id}>
                            <div className="row-main">
                              <div className="row-title">{villa.name}</div>
                              <div className="row-sub">{villa.villa_code}</div>
                            </div>
                            <button
                              type="button"
                              className="button button-secondary button-small"
                              disabled={busyId === villa.id || !canCreate}
                              onClick={async () => {
                                setBusyId(villa.id)
                                setError(null)
                                try {
                                  await setVillaArchived(villa.id, false)
                                  await load()
                                } catch (err) {
                                  setError((err as Error).message)
                                } finally {
                                  setBusyId(null)
                                }
                              }}
                            >
                              {t('home.unarchive')}
                            </button>
                          </div>
                        ))}
                      </div>
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
      {toast && <Toast key={toast.id} message={toast.text} onDone={hideToast} />}
    </>
  )
}
