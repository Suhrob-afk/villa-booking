import { useCallback, useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import {
  createVilla,
  deleteVilla,
  fetchVilla,
  fetchVillaManagers,
  linkManager,
  unlinkManager,
  updateVilla,
  type VillaInput,
} from '../lib/api'
import { useAuth } from '../lib/auth'
import { CURRENCIES } from '../lib/format'
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
  }
}

/** Villa Setup — owner only. Rates, commission and the manager roster. */
export default function VillaSetup() {
  const { villaId } = useParams<{ villaId: string }>()
  const navigate = useNavigate()
  const { user } = useAuth()
  const isNew = !villaId

  const [form, setForm] = useState<FormState>(BLANK)
  const [managers, setManagers] = useState<User[]>([])
  const [managerInput, setManagerInput] = useState('')
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
      const [villa, roster] = await Promise.all([fetchVilla(villaId), fetchVillaManagers(villaId)])
      setForm({
        name: villa.name,
        location: villa.location ?? '',
        currency: villa.currency,
        weekday_price: String(villa.weekday_price),
        weekend_price: String(villa.weekend_price),
        commission_percent: String(round4(villa.commission_rate * 100)),
        platform_fee_percent: String(round4(villa.platform_fee_rate * 100)),
        capacity: villa.capacity ? String(villa.capacity) : '',
      })
      setManagers(roster)
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
  if (user.role !== 'owner') {
    return (
      <>
        <TopBar title="Villa setup" onBack={goBack} />
        <main className="screen">
          <Alert>Only the villa owner can change rates and commission.</Alert>
        </main>
      </>
    )
  }

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((current) => ({ ...current, [key]: value }))

  async function save() {
    if (!form.name.trim()) {
      setError('Give the villa a name.')
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

  async function addManager() {
    const telegramId = Number(managerInput.trim())
    if (!telegramId) {
      setError('Enter the manager’s numeric Telegram ID.')
      return
    }
    setError(null)
    try {
      const manager = await linkManager(villaId!, telegramId)
      setManagers((current) => (current.some((m) => m.id === manager.id) ? current : [...current, manager]))
      setManagerInput('')
      notify('success')
    } catch (err) {
      notify('error')
      setError((err as Error).message)
    }
  }

  async function removeManager(manager: User) {
    if (!(await confirmAction(`Remove ${manager.name} from this villa?`))) return
    try {
      await unlinkManager(villaId!, manager.id)
      setManagers((current) => current.filter((m) => m.id !== manager.id))
    } catch (err) {
      setError((err as Error).message)
    }
  }

  async function removeVilla() {
    if (!(await confirmAction('Delete this villa and all of its bookings? This cannot be undone.'))) return
    try {
      await deleteVilla(villaId!)
      navigate('/', { replace: true })
    } catch (err) {
      setError((err as Error).message)
    }
  }

  if (loading) return <Loading />
  if (loadError) return <ErrorState message={loadError} onRetry={load} />

  return (
    <>
      <TopBar title={isNew ? 'New villa' : 'Villa setup'} onBack={goBack} />
      <main className="screen">
        {error && <Alert>{error}</Alert>}

        <div className="card card-pad">
          <div className="field">
            <label htmlFor="name">Villa name</label>
            <input id="name" value={form.name} onChange={(e) => set('name', e.target.value)} placeholder="Chorvoq House" />
          </div>
          <div className="field">
            <label htmlFor="location">Location</label>
            <input
              id="location"
              value={form.location}
              onChange={(e) => set('location', e.target.value)}
              placeholder="Chorvoq, Tashkent region"
            />
          </div>
          <div className="field-row">
            <div className="field">
              <label htmlFor="currency">Currency</label>
              <select id="currency" value={form.currency} onChange={(e) => set('currency', e.target.value)}>
                {CURRENCIES.map((code) => (
                  <option key={code} value={code}>
                    {code}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="capacity">Capacity</label>
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
          <p className="field-hint">Currency is set per villa — mixing USD and UZS villas is fine.</p>
        </div>

        <p className="section-title">Nightly rates</p>
        <div className="card card-pad">
          <div className="field-row">
            <div className="field">
              <label htmlFor="weekday">Weekday (Mon–Fri)</label>
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
              <label htmlFor="weekend">Weekend (Sat–Sun)</label>
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
          <p className="field-hint">Used to pre-fill booking totals. Managers can still adjust a total by hand.</p>
        </div>

        <p className="section-title">Commission</p>
        <div className="card card-pad">
          <div className="field-row">
            <div className="field">
              <label htmlFor="commission">Manager commission %</label>
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
              <label htmlFor="platform">Platform fee %</label>
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
          <p className="field-hint">
            Changing these only affects new bookings — existing bookings keep the rate they were created with.
          </p>
        </div>

        {!isNew && (
          <>
            <p className="section-title">Managers</p>
            <div className="list">
              {managers.length === 0 && <div className="empty">No managers linked yet.</div>}
              {managers.map((manager) => (
                <div className="row row-static" key={manager.id}>
                  <div className="row-main">
                    <div className="row-title">{manager.name}</div>
                    <div className="row-sub">Telegram ID {manager.telegram_id}</div>
                  </div>
                  <button
                    type="button"
                    className="button button-danger button-small"
                    onClick={() => void removeManager(manager)}
                  >
                    Remove
                  </button>
                </div>
              ))}
            </div>
            <div className="card card-pad" style={{ marginTop: 12 }}>
              <div className="field" style={{ marginBottom: 10 }}>
                <label htmlFor="manager-id">Add manager by Telegram ID</label>
                <input
                  id="manager-id"
                  inputMode="numeric"
                  value={managerInput}
                  onChange={(e) => setManagerInput(e.target.value)}
                  placeholder="123456789"
                />
              </div>
              <button type="button" className="button button-secondary" onClick={() => void addManager()}>
                Link manager
              </button>
              <p className="field-hint">They need to have opened the app once and signed up as a manager.</p>
            </div>
          </>
        )}

        <div className="button-row">
          <button type="button" className="button" disabled={saving} onClick={() => void save()}>
            {saving ? 'Saving…' : isNew ? 'Create villa' : 'Save changes'}
          </button>
        </div>

        {!isNew && (
          <div className="button-row">
            <button type="button" className="button button-danger" onClick={() => void removeVilla()}>
              Delete villa
            </button>
          </div>
        )}
      </main>
    </>
  )
}

function round4(value: number): number {
  return Math.round(value * 10000) / 10000
}
