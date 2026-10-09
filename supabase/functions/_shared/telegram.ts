// ============================================================================
// Telegram initData verification, shared by every function that acts on
// behalf of a Mini App visitor (telegram-auth and the public booking page).
//
// Supabase bundles relative imports into each function at deploy time, so
// this file needs no deploy of its own -- but every function importing it has
// to be redeployed when it changes.
// ============================================================================

/** How old initData may be. Telegram signs it once, when the Mini App opens. */
export const INITDATA_MAX_AGE_SECONDS = 60 * 60 * 24

const encoder = new TextEncoder()

export async function hmacSha256(key: ArrayBuffer | Uint8Array, message: string): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    key as BufferSource,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  return new Uint8Array(await crypto.subtle.sign('HMAC', cryptoKey, encoder.encode(message)))
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** Constant-time comparison so a wrong hash leaks no timing information. */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

export type TelegramUser = {
  id: number
  first_name?: string
  last_name?: string
  username?: string
  language_code?: string
}

export interface VerifiedInitData {
  user: TelegramUser
  /** The `startapp` value of the link that opened the Mini App, if any. Signed. */
  startParam: string | null
}

/**
 * Verifies initData per Telegram's spec:
 *   secret = HMAC_SHA256(key: "WebAppData", data: bot_token)
 *   hash   = HMAC_SHA256(key: secret,       data: sorted "k=v" lines)
 *
 * As of Bot API 8.0 (Nov 2024), 'signature' (the Ed25519 field) is part of
 * that sorted field list -- only 'hash' itself is excluded.
 *
 * Throws with a message safe to show the visitor.
 */
export async function verifyInitData(initData: string, botToken: string): Promise<VerifiedInitData> {
  const params = new URLSearchParams(initData)
  const hash = params.get('hash')
  if (!hash) throw new Error('initData is missing its hash')
  params.delete('hash')

  const dataCheckString = [...params.entries()]
    .map(([k, v]) => `${k}=${v}`)
    .sort()
    .join('\n')

  const secret = await hmacSha256(encoder.encode('WebAppData'), botToken)
  const computed = toHex(await hmacSha256(secret, dataCheckString))
  if (!timingSafeEqual(computed, hash)) throw new Error('initData signature is invalid')

  const authDate = Number(params.get('auth_date') ?? 0)
  if (!authDate || Math.floor(Date.now() / 1000) - authDate > INITDATA_MAX_AGE_SECONDS) {
    throw new Error('initData has expired, please reopen the app')
  }

  const rawUser = params.get('user')
  if (!rawUser) throw new Error('initData contains no user')

  return {
    user: JSON.parse(rawUser) as TelegramUser,
    startParam: params.get('start_param'),
  }
}

/** The display name Telegram gives us, with fallbacks so it is never empty. */
export function telegramDisplayName(user: TelegramUser): string {
  return [user.first_name, user.last_name].filter(Boolean).join(' ').trim() || user.username || `User ${user.id}`
}

/** villas.villa_code: the literal prefix and at least four digits. */
export function isVillaCode(value: unknown): value is string {
  return typeof value === 'string' && /^villa_id[0-9]{4,}$/.test(value)
}
