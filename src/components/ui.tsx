import type { ReactNode } from 'react'

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
  return (
    <header className="topbar">
      {onBack && (
        <button type="button" className="icon-button" onClick={onBack} aria-label="Back">
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

export function TabBar({ active, onChange }: { active: Tab; onChange: (tab: Tab) => void }) {
  return (
    <nav className="tabbar">
      <button type="button" className={active === 'villas' ? 'active' : ''} onClick={() => onChange('villas')}>
        <span aria-hidden="true">▤</span>
        Villas
      </button>
      <button
        type="button"
        className={active === 'commissions' ? 'active' : ''}
        onClick={() => onChange('commissions')}
      >
        <span aria-hidden="true">◈</span>
        Commissions
      </button>
    </nav>
  )
}

export function Loading({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="center-state">
      <div className="spinner" />
      <p>{label}</p>
    </div>
  )
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="center-state">
      <h2>Something went wrong</h2>
      <p>{message}</p>
      {onRetry && (
        <button type="button" className="button button-secondary button-small" onClick={onRetry}>
          Try again
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
