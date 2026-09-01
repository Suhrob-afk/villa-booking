declare const __BUILD_ID__: string

/** The build this running bundle came from. */
export const BUILD_ID = typeof __BUILD_ID__ === 'string' ? __BUILD_ID__ : 'dev'

/**
 * True when a newer build has been deployed since this WebView loaded. Fetched
 * with `no-store` so an intermediary cache cannot mask the very staleness we
 * are testing for. Any failure answers false: a network blip must never
 * trigger a reload loop.
 */
export async function isStaleBuild(): Promise<boolean> {
  if (BUILD_ID === 'dev') return false
  try {
    const response = await fetch(`/version.json?t=${Date.now()}`, { cache: 'no-store' })
    if (!response.ok) return false
    const { buildId } = (await response.json()) as { buildId?: string }
    return typeof buildId === 'string' && buildId !== BUILD_ID
  } catch {
    return false
  }
}
