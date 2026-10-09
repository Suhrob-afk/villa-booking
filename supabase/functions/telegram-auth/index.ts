// ============================================================================
// telegram-auth — turns Telegram initData into a Supabase-compatible JWT.
//
//   1. Verify the initData HMAC with the bot token (proves Telegram signed it).
//   2. Look up public.users by telegram_id. Registration normally happens in
//      the bot conversation; the one exception is a visitor arriving through
//      a villa's public booking link (startapp=villa_id0001), who is
//      registered here on the spot as a bare client.
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

import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4'
import { corsHeaders, json } from '../_shared/http.ts'
import {
  hmacSha256,
  isVillaCode,
  telegramDisplayName,
  verifyInitData,
  type TelegramUser,
} from '../_shared/telegram.ts'

const TOKEN_TTL_SECONDS = 60 * 60 * 24 // 24h

const encoder = new TextEncoder()

function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

type Lang = 'en' | 'ru' | 'uz'

/** Telegram's client locale, narrowed to the three the app speaks. */
function languageFrom(code: string | undefined): Lang {
  const short = (code ?? '').slice(0, 2).toLowerCase()
  return short === 'ru' || short === 'uz' ? short : 'en'
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
  const signature = base64url(await hmacSha256(encoder.encode(secret), unsigned))
  return { token: `${unsigned}.${signature}`, expiresAt }
}

/**
 * A first-time visitor arriving through a villa's public booking link becomes
 * a bare client on the spot -- no bot conversation first. Only for a link to
 * a live villa: start_param is part of the signed initData, so this cannot be
 * triggered by anything but a genuine t.me/oikoz_villa_bot/open?startapp=...
 * link, and a stale or made-up code registers nobody.
 *
 *   is_owner / is_makler  false: a client
 *   name                  their Telegram name; full_name stays null until
 *                         they ever run the bot's onboarding
 *   language              Telegram's language_code, else English
 *   role                  set explicitly to 'manager'. The column is retired
 *                         (0004) but still NOT NULL; 'manager' is its default
 *                         and what every bot-registered user already holds.
 *                         Nothing reads it.
 *   oikoz_id              left to the column default, which mints the next one
 *   phone                 asked for only when they try to book
 *
 * Two first opens racing (Telegram can fire the page twice) both upsert; the
 * unique telegram_id keeps one row and the loser just reads it back.
 */
async function registerVisitor(
  admin: SupabaseClient,
  tgUser: TelegramUser,
  villaCode: string,
): Promise<{ user: Record<string, unknown> | null; error?: string }> {
  const { data: villa, error: villaError } = await admin
    .from('villas')
    .select('id')
    .eq('villa_code', villaCode)
    .is('archived_at', null)
    .maybeSingle()
  if (villaError) return { user: null, error: villaError.message }
  if (!villa) return { user: null }

  const { error: insertError } = await admin.from('users').upsert(
    {
      telegram_id: tgUser.id,
      name: telegramDisplayName(tgUser),
      language: languageFrom(tgUser.language_code),
      role: 'manager',
      is_owner: false,
      is_makler: false,
    },
    { onConflict: 'telegram_id', ignoreDuplicates: true },
  )
  if (insertError) return { user: null, error: insertError.message }

  const { data, error } = await admin.from('users').select('*').eq('telegram_id', tgUser.id).single()
  if (error) return { user: null, error: error.message }
  return { user: data }
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
  let startParam: string | null = null
  if (body.initData) {
    if (!botToken) return json({ error: 'TELEGRAM_BOT_TOKEN is not configured' }, 500)
    try {
      const verified = await verifyInitData(body.initData, botToken)
      tgUser = verified.user
      startParam = verified.startParam
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
  // Usually purely a lookup: registration (language, phone, name, owner/makler)
  // happens in the telegram-bot-webhook conversation, so an unknown Telegram id
  // is sent back to the bot. The exception is below.
  const { data: found, error: lookupError } = await admin
    .from('users')
    .select('*')
    .eq('telegram_id', tgUser.id)
    .maybeSingle()

  if (lookupError) return json({ error: lookupError.message }, 500)

  let user = found
  if (!user && isVillaCode(startParam)) {
    const registered = await registerVisitor(admin, tgUser, startParam)
    if (registered.error) return json({ error: registered.error }, 500)
    user = registered.user
  }

  if (!user) {
    return json({ needsRegistration: true, telegram: { id: tgUser.id, name: telegramDisplayName(tgUser) } }, 200)
  }

  const { token, expiresAt } = await mintJwt(user.id, tgUser.id, jwtSecret!)
  return json({ token, expiresAt, user })
})
