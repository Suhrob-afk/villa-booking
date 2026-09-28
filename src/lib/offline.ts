/**
 * Offline support, deliberately view-only.
 *
 * Reads fall back to the last successful response so a disconnected app shows
 * what it last knew instead of an error. Writes are blocked outright rather
 * than queued: replaying an edit made offline could double-book a villa that
 * somebody else booked in the meantime, and silently losing that race is worse
 * than making the person wait for a connection.
 */

import { useEffect, useState } from 'react'
import { currentLang, translate } from './strings'

const PREFIX = 'oikoz.cache.'

/**
 * Whether the browser thinks it is online. `navigator.onLine` is a floor, not
 * a guarantee -- it reports the interface, not whether anything is reachable --
 * so the read cache below still has to cope with a fetch failing anyway.
 */
export function useOnline(): boolean {
  const [online, setOnline] = useState(() => navigator.onLine)

  useEffect(() => {
    const update = () => setOnline(navigator.onLine)
    window.addEventListener('online', update)
    window.addEventListener('offline', update)
    return () => {
      window.removeEventListener('online', update)
      window.removeEventListener('offline', update)
    }
  }, [])

  return online
}

function readSnapshot<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(PREFIX + key)
    return raw ? (JSON.parse(raw) as T) : null
  } catch {
    return null
  }
}

function writeSnapshot(key: string, value: unknown): void {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(value))
  } catch {
    // Quota or private mode: caching is a convenience, never a requirement.
  }
}

export interface Cached<T> {
  data: T
  /** True when the network failed and this came from the last good response. */
  fromCache: boolean
}

/**
 * Runs `load`, remembering the result. If it throws -- offline, or a request
 * that never lands -- the last good response for that key is returned instead.
 * With nothing cached the original error propagates, so a first-ever visit
 * offline still reports honestly rather than rendering emptiness.
 */
export async function withCache<T>(key: string, load: () => Promise<T>): Promise<Cached<T>> {
  try {
    const data = await load()
    writeSnapshot(key, data)
    return { data, fromCache: false }
  } catch (err) {
    const snapshot = readSnapshot<T>(key)
    if (snapshot !== null) return { data: snapshot, fromCache: true }
    throw err
  }
}

/** Registers the shell cache. Absent service-worker support, nothing changes. */
export function registerServiceWorker(): void {
  // Never in development: the dev server hands out unhashed module URLs, and a
  // cache sitting in front of them serves yesterday's code.
  if (!import.meta.env.PROD) return
  if (!('serviceWorker' in navigator)) return
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('/sw.js').catch(() => {
      // Blocked, unsupported (iOS WKWebView), or served without HTTPS. The app
      // works exactly as before; it just will not start while offline.
    })
  })
}

/**
 * Refuses a write while the device is offline, in the user's own language.
 *
 * Deliberately not a queue. Replaying an edit after reconnecting could
 * double-book a villa somebody else booked in the meantime, so the change is
 * declined outright and the person is told to reconnect.
 */
export function assertOnline(): void {
  if (!navigator.onLine) throw new Error(translate(currentLang(), 'offline.readOnly'))
}
