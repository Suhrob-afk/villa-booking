/** Thin, typed wrapper over the Telegram Mini App bridge. */

interface TelegramWebApp {
  initData: string
  initDataUnsafe?: {
    user?: { id: number; first_name?: string; last_name?: string; username?: string; language_code?: string }
  }
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
  onEvent?(event: string, cb: () => void): void
  offEvent?(event: string, cb: () => void): void
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

/**
 * The locale Telegram reports for this client, e.g. "ru" or "uz". Only ever a
 * first guess for somebody this device has never signed in as -- the language
 * saved on the user row outranks it the moment that row arrives.
 */
export function telegramLanguageCode(): string | null {
  const code = tg()?.initDataUnsafe?.user?.language_code
  return typeof code === 'string' && code ? code.slice(0, 2).toLowerCase() : null
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

/**
 * Fires whenever the Mini App comes back to the foreground. Telegram may reuse
 * a live WebView instead of reloading it, so "opened again" is not the same as
 * "mounted again" — several signals are wired up because coverage differs by
 * client version (`activated` needs Bot API 8.0).
 */
export function onForeground(handler: () => void): () => void {
  const onVisible = () => {
    if (document.visibilityState === 'visible') handler()
  }
  document.addEventListener('visibilitychange', onVisible)
  window.addEventListener('pageshow', onVisible)
  window.addEventListener('focus', onVisible)

  const app = tg()
  app?.onEvent?.('activated', handler)

  return () => {
    document.removeEventListener('visibilitychange', onVisible)
    window.removeEventListener('pageshow', onVisible)
    window.removeEventListener('focus', onVisible)
    app?.offEvent?.('activated', handler)
  }
}
