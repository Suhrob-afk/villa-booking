/** Thin, typed wrapper over the Telegram Mini App bridge. */

interface TelegramWebApp {
  initData: string
  initDataUnsafe?: { user?: { id: number; first_name?: string; last_name?: string; username?: string } }
  colorScheme?: 'light' | 'dark'
  ready(): void
  expand(): void
  close(): void
  setHeaderColor?(color: string): void
  setBackgroundColor?(color: string): void
  BackButton?: { show(): void; hide(): void; onClick(cb: () => void): void; offClick(cb: () => void): void }
  HapticFeedback?: {
    impactOccurred(style: 'light' | 'medium' | 'heavy'): void
    notificationOccurred(type: 'error' | 'success' | 'warning'): void
  }
  showConfirm?(message: string, cb: (ok: boolean) => void): void
  showAlert?(message: string, cb?: () => void): void
}

declare global {
  interface Window {
    Telegram?: { WebApp?: TelegramWebApp }
  }
}

export function tg(): TelegramWebApp | undefined {
  return window.Telegram?.WebApp
}

export function initTelegram(): void {
  const app = tg()
  if (!app) return
  app.ready()
  app.expand()
}

export function isTelegramClient(): boolean {
  return Boolean(tg()?.initData)
}

export function colorScheme(): 'light' | 'dark' {
  return tg()?.colorScheme === 'dark' ? 'dark' : 'light'
}

export function haptic(style: 'light' | 'medium' | 'heavy' = 'light'): void {
  tg()?.HapticFeedback?.impactOccurred(style)
}

export function notify(type: 'error' | 'success' | 'warning'): void {
  tg()?.HapticFeedback?.notificationOccurred(type)
}

/** Telegram's native confirm sheet, falling back to the browser's in dev. */
export function confirmAction(message: string): Promise<boolean> {
  const app = tg()
  if (app?.showConfirm) {
    return new Promise((resolve) => app.showConfirm!(message, resolve))
  }
  return Promise.resolve(window.confirm(message))
}
