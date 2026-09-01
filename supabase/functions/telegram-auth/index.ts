// ============================================================================
// telegram-auth — turns Telegram initData into a Supabase-compatible JWT.
//
//   1. Verify the initData HMAC with the bot token (proves Telegram signed it).
//   2. Look up public.users by telegram_id. On first login, register the
//      person: full name, phone, and role(s) -- owner, manager, or both --
//      then mint them an oikoz_id, the short code they hand other people to
//      link up (their Telegram id itself is never exposed to anyone else).
//   3. Mint an HS256 JWT signed with the project's JWT secret, with
//      sub = users.id and role = authenticated, so RLS sees auth.uid().
//
// Secrets you set:
//   TELEGRAM_BOT_TOKEN  — from @BotFather
//   APP_JWT_SECRET      — the project's legacy HS256 JWT secret (Settings ->
//                         API -> JWT Settings). It is NOT named
//                         SUPABASE_JWT_SECRET because the platform rejects any
//                         secret whose name starts with SUPABASE_.
// Injected automatically:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
// Optional:
//   ALLOW_DEV_LOGIN=true  — accept { devTelegramId } without a signature.
//                           Local development only. Never enable in production.
// ============================================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4'

const TOKEN_TTL_SECONDS = 60 * 60 * 24 // 24h
const INITDATA_MAX_AGE_SECONDS = 60 * 60 * 24

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

const encoder = new TextEncoder()

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

async function hmac(key: ArrayBuffer | Uint8Array, message: string): Promise<Uint8Array> {
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
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

type TelegramUser = {
  id: number
  first_name?: string
  last_name?: string
  username?: string
}

/**
 * Verifies initData per Telegram's spec:
 *   secret = HMAC_SHA256(key: "WebAppData", data: bot_token)
 *   hash   = HMAC_SHA256(key: secret,       data: sorted "k=v" lines)
 *
 * As of Bot API 8.0 (Nov 2024), 'signature' (the Ed25519 field) is part of
 * that sorted field list -- only 'hash' itself is excluded.
 */
async function verifyInitData(initData: string, botToken: string): Promise<TelegramUser> {
  const params = new URLSearchParams(initData)
  const hash = params.get('hash')
  if (!hash) throw new Error('initData is missing its hash')
  params.delete('hash')

  const dataCheckString = [...params.entries()]
    .map(([k, v]) => `${k}=${v}`)
    .sort()
    .join('\n')

  const secret = await hmac(encoder.encode('WebAppData'), botToken)
  const computed = toHex(await hmac(secret, dataCheckString))
  if (!timingSafeEqual(computed, hash)) throw new Error('initData signature is invalid')

  const authDate = Number(params.get('auth_date') ?? 0)
  if (!authDate || Math.floor(Date.now() / 1000) - authDate > INITDATA_MAX_AGE_SECONDS) {
    throw new Error('initData has expired, please reopen the app')
  }

  const rawUser = params.get('user')
  if (!rawUser) throw new Error('initData contains no user')
  return JSON.parse(rawUser) as TelegramUser
}

async function mintJwt(userId: string, telegramId: number, secret: string): Promise<{ token: string; expiresAt: number }> {
  const issuedAt = Math.floor(Date.now() / 1000)
  const expiresAt = issuedAt + TOKEN_TTL_SECONDS
  const header = { alg: 'HS256', typ: 'JWT' }
  const payload = {
    sub: userId,
    role: 'authenticated',
    aud: 'authenticated',
    iss: 'telegram-auth',
    telegram_id: telegramId,
    iat: issuedAt,
    exp: expiresAt,
  }
  const unsigned = `${base64url(encoder.encode(JSON.stringify(header)))}.${base64url(
    encoder.encode(JSON.stringify(payload)),
  )}`
  const signature = base64url(await hmac(encoder.encode(secret), unsigned))
  return { token: `${unsigned}.${signature}`, expiresAt }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST') return json({ error: 'Use POST' }, 405)

  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  const jwtSecret = Deno.env.get('APP_JWT_SECRET')
  const botToken = Deno.env.get('TELEGRAM_BOT_TOKEN')

  const missing = [
    ['SUPABASE_URL', supabaseUrl],
    ['SUPABASE_SERVICE_ROLE_KEY', serviceKey],
    ['APP_JWT_SECRET', jwtSecret],
  ].filter(([, value]) => !value).map(([name]) => name)

  if (missing.length > 0) {
    return json({ error: `Edge Function is missing ${missing.join(', ')}` }, 500)
  }

  let body: { initData?: string; devTelegramId?: number }
  try {
    body = await req.json()
  } catch {
    return json({ error: 'Body must be JSON' }, 400)
  }

  // ---- identify the Telegram user --------------------------------------
  let tgUser: TelegramUser
  if (body.initData) {
    if (!botToken) return json({ error: 'TELEGRAM_BOT_TOKEN is not configured' }, 500)
    try {
      tgUser = await verifyInitData(body.initData, botToken)
    } catch (err) {
      return json({ error: (err as Error).message }, 401)
    }
  } else if (body.devTelegramId && Deno.env.get('ALLOW_DEV_LOGIN') === 'true') {
    tgUser = { id: Number(body.devTelegramId), first_name: `Dev ${body.devTelegramId}` }
  } else {
    return json({ error: 'Open this app from Telegram.' }, 401)
  }

  const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } })

  // ---- look up the app user --------------------------------------------
  // Purely a lookup. Registration (language, phone, name, owner/makler) happens
  // in the telegram-bot-webhook conversation before the Mini App is opened, so
  // there is nothing to create here -- an unknown Telegram id is sent back to
  // the bot instead.
  const { data: user, error: lookupError } = await admin
    .from('users')
    .select('*')
    .eq('telegram_id', tgUser.id)
    .maybeSingle()

  if (lookupError) return json({ error: lookupError.message }, 500)

  if (!user) {
    const telegramName = [tgUser.first_name, tgUser.last_name].filter(Boolean).join(' ').trim() ||
      tgUser.username || `User ${tgUser.id}`
    return json({ needsRegistration: true, telegram: { id: tgUser.id, name: telegramName } }, 200)
  }

  const { token, expiresAt } = await mintJwt(user.id, tgUser.id, jwtSecret!)
  return json({ token, expiresAt, user })
})
