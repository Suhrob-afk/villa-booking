import { Check, Globe, House, Wallet } from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useAuth } from '../lib/auth'
import { formatDateShort } from '../lib/dates'
import { formatMoney } from '../lib/format'
import { useI18n } from '../lib/i18n'
import { useOnline } from '../lib/offline'
import { combineToUsd, formatRate, useExchangeRate } from '../lib/rates'
import { LANGS, LANGUAGE_NAMES } from '../lib/strings'
import { notify } from '../lib/telegram'

export function TopBar({
  title,
  subtitle,
  onBack,
  action,
}: {
  title: string
  subtitle?: string
  onBack?: () => void
  action?: ReactNode
}) {
  const { t } = useI18n()
  return (
    <header className="topbar">
      {onBack && (
        <button
          type="button"
          className="icon-button icon-button-lg"
          onClick={onBack}
          aria-label={t('common.back')}
        >
          ‹
        </button>
      )}
      <h1>
        {title}
        {subtitle && <span className="subtitle">{subtitle}</span>}
      </h1>
      {action}
    </header>
  )
}

export type Tab = 'villas' | 'commissions'

/** Icons inherit `currentColor`, so the active/inactive colours already on the
 *  buttons keep working untouched. */
const ICON_SIZE = 24
const ICON_STROKE = 1.75

export function TabBar({ active, onChange }: { active: Tab; onChange: (tab: Tab) => void }) {
  const { t } = useI18n()
  return (
    <nav className="tabbar">
      <button type="button" className={active === 'villas' ? 'active' : ''} onClick={() => onChange('villas')}>
        <House size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
        {t('tabs.villas')}
      </button>
      <button
        type="button"
        className={active === 'commissions' ? 'active' : ''}
        onClick={() => onChange('commissions')}
      >
        <Wallet size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
        {t('tabs.commissions')}
      </button>
    </nav>
  )
}

export function Loading({ label }: { label?: string }) {
  const { t } = useI18n()
  return (
    <div className="center-state">
      <div className="spinner" />
      <p>{label ?? t('common.loading')}</p>
    </div>
  )
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  const { t } = useI18n()
  return (
    <div className="center-state">
      <h2>{t('common.errorTitle')}</h2>
      <p>{message}</p>
      {onRetry && (
        <button type="button" className="button button-secondary button-small" onClick={onRetry}>
          {t('common.tryAgain')}
        </button>
      )}
    </div>
  )
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="card empty">
      <strong>{title}</strong>
      {children}
    </div>
  )
}

export function Alert({ kind = 'error', children }: { kind?: 'error' | 'info'; children: ReactNode }) {
  return <div className={`alert alert-${kind}`}>{children}</div>
}

/**
 * Language control that lives in the app header. Writes users.language -- the
 * same column the bot's /language command sets -- so the two surfaces always
 * agree. Each option is written in its own language: translating them would be
 * useless to somebody who cannot read the one currently active.
 */
function LanguageControl() {
  const { lang, setLang, t } = useI18n()
  const online = useOnline()
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const root = useRef<HTMLDivElement>(null)

  // Dismiss the menu the way a native one behaves: tap anywhere else, or Esc.
  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  return (
    <div className="lang-control" ref={root}>
      <button
        type="button"
        className="lang-button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t('common.language')}
        onClick={() => {
          setError(null)
          setOpen((current) => !current)
        }}
      >
        <Globe size={15} strokeWidth={1.9} aria-hidden="true" />
        <span>{lang.toUpperCase()}</span>
      </button>

      {open && (
        <div className="lang-menu" role="menu">
          {LANGS.map((code) => (
            <button
              key={code}
              type="button"
              role="menuitemradio"
              aria-checked={lang === code}
              lang={code}
              disabled={busy || !online}
              onClick={async () => {
                if (code === lang) return setOpen(false)
                setBusy(true)
                setError(null)
                try {
                  await setLang(code)
                  setOpen(false)
                } catch {
                  notify('error')
                  setError(t('error.languageSaveFailed'))
                } finally {
                  setBusy(false)
                }
              }}
            >
              <span>{LANGUAGE_NAMES[code]}</span>
              {lang === code && <Check size={15} strokeWidth={2.2} aria-hidden="true" />}
            </button>
          ))}
          {error && <p className="lang-error">{error}</p>}
        </div>
      )}
    </div>
  )
}

/**
 * The identity header shown on Home, for every kind of user. Owner, Makler,
 * both at once and client all get the same heading, the same "Role · oikoz_id"
 * subtitle and the same language control -- deriving all of it here rather
 * than at the call site is what stops the two views drifting apart again.
 *
 * `action` is for anything role-specific that belongs beside it, e.g. the
 * owner's "add villa" button.
 */
export function ProfileHeader({ action }: { action?: ReactNode }) {
  const { user } = useAuth()
  const { t } = useI18n()
  if (!user) return null

  const roleLabel =
    user.is_owner && user.is_makler
      ? t('home.roleOwnerMakler')
      : user.is_owner
        ? t('home.roleOwner')
        : user.is_makler
          ? t('home.roleMakler')
          : t('home.roleClient')

  // full_name is what the bot collected; name is the Telegram fallback for
  // anyone registered before that step existed.
  const displayName = user.full_name?.trim() || user.name

  return (
    <TopBar
      title={displayName}
      subtitle={`${roleLabel} · ${user.oikoz_id}`}
      action={
        <div className="topbar-actions">
          <LanguageControl />
          {action}
        </div>
      }
    />
  )
}

/**
 * A single USD figure across currencies, shown *underneath* the per-currency
 * cards rather than instead of them: those stay the accurate ground truth and
 * this is a convenience on top.
 *
 * It removes itself whenever it cannot be trusted -- no rate (the bank was
 * unreachable), only one currency in play (nothing to combine), or an amount
 * in some currency the rate does not cover. The rate and its date are always
 * printed with the figure: totals are converted at today's rate rather than
 * the rate of the month being viewed, so a past month's combined number moves
 * a little day to day, and the label has to make that visible.
 */
export function CombinedTotal({ rows }: { rows: { label: string; entries: [string, number][] }[] }) {
  const { lang, t } = useI18n()
  const rate = useExchangeRate()
  if (!rate) return null

  const currencies = new Set(rows.flatMap((row) => row.entries.map(([currency]) => currency)))
  if (currencies.size < 2) return null

  const converted = rows.map((row) => ({ label: row.label, total: combineToUsd(row.entries, rate) }))
  if (converted.some((row) => row.total === null)) return null

  return (
    <div className="card card-pad combined-total">
      <p className="section-title" style={{ marginTop: 0 }}>
        {t('combined.title')}
      </p>
      <dl className="summary">
        {converted.map((row) => (
          <div className="summary-row total" key={row.label}>
            <dt>{row.label}</dt>
            <dd>{t('combined.approx', { amount: formatMoney(row.total as number, 'USD') })}</dd>
          </div>
        ))}
      </dl>
      <p className="combined-rate">
        {t(rate.stale ? 'combined.staleNote' : 'combined.rateNote', {
          date: rate.rateDate ? formatDateShort(rate.rateDate, lang) : '—',
          rate: formatRate(rate.rate),
        })}
        <br />
        {t('combined.drift')}
      </p>
    </div>
  )
}

/**
 * Says plainly that what is on screen is not live. It also pushes the layout
 * down by its own height (via a class on <body>), so it can stay pinned
 * without covering the sticky top bar underneath it.
 */
export function OfflineBanner() {
  const { t } = useI18n()
  const online = useOnline()

  useEffect(() => {
    document.body.classList.toggle('is-offline', !online)
    return () => document.body.classList.remove('is-offline')
  }, [online])

  if (online) return null
  return <div className="offline-banner">{t('offline.banner')}</div>
}
