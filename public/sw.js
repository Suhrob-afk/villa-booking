/**
 * Offline shell for the Mini App.
 *
 * View-only by design: this caches what is needed to *render* the app without
 * a connection. It never touches a write, and it never queues one -- two
 * people editing the same villa while disconnected is exactly the
 * double-booking this app must not produce.
 *
 * Three rules, in order:
 *   1. Only same-origin GETs are ours. Supabase and cbu.uz go straight to the
 *      network, so data freshness and auth stay entirely the app's business.
 *   2. /version.json is never cached. The stale-build check reads it with
 *      no-store to decide whether a kept-alive WebView is running old code;
 *      serving that from a cache would defeat the only mechanism that gets a
 *      new deploy onto a long-lived Telegram WebView.
 *   3. Navigations are network-first. A cached index.html would otherwise
 *      pin users to an old bundle forever. Hashed assets are content-addressed
 *      and therefore safe to serve cache-first.
 */

const CACHE = 'villa-crm-shell-v1'

self.addEventListener('install', () => {
  // Take over promptly; there is no migration to stage.
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys()
      await Promise.all(names.filter((name) => name !== CACHE).map((name) => caches.delete(name)))
      await self.clients.claim()
    })(),
  )
})

self.addEventListener('fetch', (event) => {
  const request = event.request
  if (request.method !== 'GET') return

  const url = new URL(request.url)
  if (url.origin !== self.location.origin) return
  if (url.pathname === '/version.json') return

  if (request.mode === 'navigate') {
    event.respondWith(
      (async () => {
        try {
          const response = await fetch(request)
          const cache = await caches.open(CACHE)
          cache.put('/index.html', response.clone())
          return response
        } catch {
          const cached = await caches.match('/index.html')
          if (cached) return cached
          throw new Error('offline and no cached shell')
        }
      })(),
    )
    return
  }

  event.respondWith(
    (async () => {
      const cached = await caches.match(request)
      if (cached) return cached
      const response = await fetch(request)
      // Only store what is worth storing; opaque and error responses are not.
      if (response.ok && response.type === 'basic') {
        const cache = await caches.open(CACHE)
        cache.put(request, response.clone())
      }
      return response
    })(),
  )
})
