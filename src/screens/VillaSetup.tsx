import { useCallback, useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import {
  countVillaBookings,
  createVilla,
  deleteVilla,
  fetchVilla,
  fetchVillaMaklers,
  linkMakler,
  setVillaArchived,
  unlinkMakler,
  updateVilla,
  type VillaInput,
} from '../lib/api'
import { useAuth } from '../lib/auth'
import { CURRENCIES, MIN_DEPOSIT } from '../lib/format'
import { useI18n } from '../lib/i18n'
import { confirmAction, notify } from '../lib/telegram'
import { useBackButton } from '../lib/useBackButton'
import type { User } from '../lib/types'
import { Alert, ErrorState, Loading, TopBar } from '../components/ui'

interface FormState {
  name: string
  location: string
  currency: string
  weekday_price: string
  weekend_price: string
  commission_percent: string
  platform_fee_percent: string
  capacity: string
  deposit_amount: string
}

const BLANK: FormState = {
  name: '',
  location: '',
  currency: 'USD',
  weekday_price: '',
  weekend_price: '',
  commission_percent: '10',
  platform_fee_percent: '0',
  capacity: '',
  deposit_amount: '250000',
}

function toInput(form: FormState): VillaInput {
  return {
    name: form.name.trim(),
    location: form.location.trim() || null,
    currency: form.currency,
    weekday_price: Number(form.weekday_price) || 0,
    weekend_price: Number(form.weekend_price) || 0,
    commission_rate: (Number(form.commission_percent) || 0) / 100,
    platform_fee_rate: (Number(form.platform_fee_percent) || 0) / 100,
    capacity: form.capacity ? Number(form.capacity) : null,
    deposit_amount: Number(form.deposit_amount) || 0,
  }
}

/** Villa Setup — owner only. Rates, commission and the makler roster. */
export default function VillaSetup() {
  const { villaId } = useParams<{ villaId: string }>()
  const navigate = useNavigate()
  const { user } = useAuth()
  const { t, tn } = useI18n()
  const isNew = !villaId

  const [form, setForm] = useState<FormState>(BLANK)
  const [managers, setManagers] = useState<User[]>([])
  const [villaCode, setVillaCode] = useState<string | null>(null)
  /** Decides whether removal means delete or archive. */
  const [bookingCount, setBookingCount] = useState(0)
  const [archivedAt, setArchivedAt] = useState<string | null>(null)
  const [removing, setRemoving] = useState(false)
  const [maklerInput, setMaklerInput] = useState('')
  const [loading, setLoading] = useState(!isNew)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)

  const goBack = useCallback(() => navigate(isNew ? '/' : `/villa/${villaId}`), [isNew, navigate, villaId])
  useBackButton(goBack)

  const load = useCallback(async () => {
    if (!villaId) return
    setLoading(true)
    setLoadError(null)
    try {
      const [villa, roster, bookings] = await Promise.all([
        fetchVilla(villaId),
        fetchVillaMaklers(villaId),
        countVillaBookings(villaId),
      ])
      setForm({
        name: villa.name,
        location: villa.location ?? '',
        currency: villa.currency,
        weekday_price: String(villa.weekday_price),
        weekend_price: String(villa.weekend_price),
        commission_percent: String(round4(villa.commission_rate * 100)),
        platform_fee_percent: String(round4(villa.platform_fee_rate * 100)),
        capacity: villa.capacity ? String(villa.capacity) : '',
        deposit_amount: String(villa.deposit_amount),
      })
      setVillaCode(villa.villa_code)
      setManagers(roster)
      setBookingCount(bookings)
      setArchivedAt(villa.archived_at)
    } catch (err) {
      setLoadError((err as Error).message)
    } finally {
      setLoading(false)
    }
  }, [villaId])

  useEffect(() => {
    void load()
  }, [load])

  if (!user) return null
  if (!user.is_owner) {
    return (
      <>
        <TopBar title={t('setup.title')} onBack={goBack} />
        <main className="screen">
          <Alert>{t('setup.ownerOnly')}</Alert>
        </main>
      </>
    )
  }

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((current) => ({ ...current, [key]: value }))

  async function save() {
    if (!form.name.trim()) {
      setError(t('setup.nameRequired'))
      return
    }
    setSaving(true)
    setError(null)
    try {
      const input = toInput(form)
      if (isNew) {
        const villa = await createVilla(user!.id, input)
        notify('success')
        navigate(`/villa/${villa.id}`, { replace: true })
      } else {
        await updateVilla(villaId!, input)
        notify('success')
        goBack()
      }
    } catch (err) {
      notify('error')
      setError((err as Error).message)
    } finally {
      setSaving(false)
    }
  }

  async function addMakler() {
    const reference = maklerInput.trim()
    if (!reference) {
      setError(t('setup.referenceRequired'))
      return
    }
    setError(null)
    try {
      const manager = await linkMakler(villaId!, reference)
      setManagers((current) => (current.some((m) => m.id === manager.id) ? current : [...current, manager]))
      setMaklerInput('')
      notify('success')
    } catch (err) {
      notify('error')
      setError((err as Error).message)
    }
  }

  async function removeMakler(manager: User) {
    if (!(await confirmAction(t('setup.removeMaklerConfirm', { name: manager.name })))) return
    try {
      await unlinkMakler(villaId!, manager.id)
      setManagers((current) => current.filter((m) => m.id !== manager.id))
    } catch (err) {
      setError((err as Error).message)
    }
  }

  /**
   * A villa with no bookings can go for good. One with history is archived
   * instead -- deleting it would cascade its bookings away, taking the
   * revenue they are counted in with them.
   */
  async function removeVilla() {
    const hasHistory = bookingCount > 0
    if (!(await confirmAction(hasHistory ? t('setup.archiveConfirm') : t('setup.deleteVillaConfirm')))) return
    setRemoving(true)
    setError(null)
    try {
      if (hasHistory) await setVillaArchived(villaId!, true)
      else await deleteVilla(villaId!)
      notify('success')
      navigate('/', { replace: true })
    } catch (err) {
      notify('error')
      setError((err as Error).message)
    } finally {
      setRemoving(false)
    }
  }

  async function restoreVilla() {
    setRemoving(true)
    setError(null)
    try {
      await setVillaArchived(villaId!, false)
      setArchivedAt(null)
      notify('success')
    } catch (err) {
      notify('error')
      setError((err as Error).message)
    } finally {
      setRemoving(false)
    }
  }

  if (loading) return <Loading />
  if (loadError) return <ErrorState message={loadError} onRetry={load} />

  return (
    <>
      <TopBar title={isNew ? t('setup.titleNew') : t('setup.title')} subtitle={villaCode ?? undefined} onBack={goBack} />
      <main className="screen">
        {error && <Alert>{error}</Alert>}

        <div className="card card-pad">
          <div className="field">
            <label htmlFor="name">{t('setup.nameLabel')}</label>
            <input
              id="name"
              value={form.name}
              onChange={(e) => set('name', e.target.value)}
              placeholder={t('setup.namePlaceholder')}
            />
          </div>
          <div className="field">
            <label htmlFor="location">{t('setup.locationLabel')}</label>
            <input
              id="location"
              value={form.location}
              onChange={(e) => set('location', e.target.value)}
              placeholder={t('setup.locationPlaceholder')}
            />
          </div>
          <div className="field-row">
            <div className="field">
              <label htmlFor="currency">{t('setup.currencyLabel')}</label>
              <select id="currency" value={form.currency} onChange={(e) => set('currency', e.target.value)}>
                {CURRENCIES.map((code) => (
                  <option key={code} value={code}>
                    {code}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="capacity">{t('setup.capacityLabel')}</label>
              <input
                id="capacity"
                type="number"
                inputMode="numeric"
                min="1"
                value={form.capacity}
                onChange={(e) => set('capacity', e.target.value)}
                placeholder="12"
              />
            </div>
          </div>
          <p className="field-hint">{t('setup.currencyHint')}</p>
        </div>

        <p className="section-title">{t('setup.ratesTitle')}</p>
        <div className="card card-pad">
          <div className="field-row">
            <div className="field">
              <label htmlFor="weekday">{t('setup.weekdayLabel')}</label>
              <input
                id="weekday"
                type="number"
                inputMode="decimal"
                min="0"
                value={form.weekday_price}
                onChange={(e) => set('weekday_price', e.target.value)}
                placeholder="0"
              />
            </div>
            <div className="field">
              <label htmlFor="weekend">{t('setup.weekendLabel')}</label>
              <input
                id="weekend"
                type="number"
                inputMode="decimal"
                min="0"
                value={form.weekend_price}
                onChange={(e) => set('weekend_price', e.target.value)}
                placeholder="0"
              />
            </div>
          </div>
          <p className="field-hint">{t('setup.ratesHint')}</p>

          <div className="field" style={{ marginTop: 14, marginBottom: 0 }}>
            <label htmlFor="deposit">{t('setup.depositLabel')}</label>
            <input
              id="deposit"
              type="number"
              inputMode="decimal"
              min={MIN_DEPOSIT}
              step="1000"
              value={form.deposit_amount}
              onChange={(e) => set('deposit_amount', e.target.value)}
            />
            <p className="field-hint">{t('setup.depositHint', { min: MIN_DEPOSIT.toLocaleString('en-US') })}</p>
          </div>
        </div>

        <p className="section-title">{t('setup.commissionTitle')}</p>
        <div className="card card-pad">
          <div className="field-row">
            <div className="field">
              <label htmlFor="commission">{t('setup.commissionLabel')}</label>
              <input
                id="commission"
                type="number"
                inputMode="decimal"
                min="0"
                max="100"
                step="0.5"
                value={form.commission_percent}
                onChange={(e) => set('commission_percent', e.target.value)}
              />
            </div>
            <div className="field">
              <label htmlFor="platform">{t('setup.platformFeeLabel')}</label>
              <input
                id="platform"
                type="number"
                inputMode="decimal"
                min="0"
                max="100"
                step="0.5"
                value={form.platform_fee_percent}
                onChange={(e) => set('platform_fee_percent', e.target.value)}
              />
            </div>
          </div>
          <p className="field-hint">{t('setup.commissionHint')}</p>
        </div>

        {!isNew && (
          <>
            <p className="section-title">{t('setup.maklersTitle')}</p>
            <div className="list">
              {managers.length === 0 && <div className="empty">{t('setup.noMaklers')}</div>}
              {managers.map((manager) => (
                <div className="row row-static" key={manager.id}>
                  <div className="row-main">
                    <div className="row-title">{manager.name}</div>
                    <div className="row-sub">
                      {manager.oikoz_id}
                    </div>
                  </div>
                  <button
                    type="button"
                    className="button button-danger button-small"
                    onClick={() => void removeMakler(manager)}
                  >
                    {t('common.remove')}
                  </button>
                </div>
              ))}
            </div>
            <div className="card card-pad" style={{ marginTop: 12 }}>
              <div className="field" style={{ marginBottom: 10 }}>
                <label htmlFor="makler-ref">{t('setup.addMaklerLabel')}</label>
                <input
                  id="makler-ref"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  value={maklerInput}
                  onChange={(e) => setMaklerInput(e.target.value)}
                  placeholder="oikoz_id0001"
                />
              </div>
              <button type="button" className="button button-secondary" onClick={() => void addMakler()}>
                {t('setup.linkMakler')}
              </button>
              <p className="field-hint">{t('setup.addMaklerHint')}</p>
            </div>
          </>
        )}

        <div className="button-row">
          <button type="button" className="button" disabled={saving} onClick={() => void save()}>
            {saving ? t('common.saving') : isNew ? t('setup.createVilla') : t('common.saveChanges')}
          </button>
        </div>

        {!isNew && (
          <>
            <p className="section-title">{t('setup.removeTitle')}</p>
            <div className="card card-pad">
              {archivedAt ? (
                <>
                  <p className="field-hint" style={{ marginTop: 0 }}>{t('setup.archivedNotice')}</p>
                  <button
                    type="button"
                    className="button button-secondary"
                    disabled={removing}
                    onClick={() => void restoreVilla()}
                  >
                    {t('setup.unarchiveVilla')}
                  </button>
                </>
              ) : (
                <>
                  <p className="field-hint" style={{ marginTop: 0 }}>
                    {bookingCount > 0
                      ? t('setup.archiveHint', { bookings: tn('bookings', bookingCount) })
                      : t('setup.deleteHint')}
                  </p>
                  <button
                    type="button"
                    className={bookingCount > 0 ? 'button button-secondary' : 'button button-danger'}
                    disabled={removing}
                    onClick={() => void removeVilla()}
                  >
                    {bookingCount > 0 ? t('setup.archiveVilla') : t('setup.deleteVilla')}
                  </button>
                </>
              )}
            </div>
          </>
        )}
      </main>
    </>
  )
}

function round4(value: number): number {
  return Math.round(value * 10000) / 10000
}
