// ============================================================================
// admin-users — the full user list for the standalone /admin panel.
//
// This function is deliberately outside the Mini App's identity model. There
// is no Telegram initData and no Supabase JWT here: the ADMIN_PANEL_PASSWORD
// check below is the *only* thing gating the data, which is why it queries
// with the service role and why nothing else about this endpoint is
// negotiable.
//
// It returns names and phone numbers for every registered user. Set
// ADMIN_PANEL_PASSWORD to a long, random value used nowhere else:
//
//   supabase secrets set ADMIN_PANEL_PASSWORD='...'
//
// Until that secret exists the function refuses to query anything, so
// deploying it before setting the password exposes nothing.
//
// telegram_id is never selected. It is the one identifier the rest of the app
// keeps away from clients, and an admin list is no reason to start leaking it.
//
// Deploy with --no-verify-jwt: there is no Supabase session to verify.
// Injected automatically: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
// ============================================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

/** Only what the panel lists. Never telegram_id. */
const COLUMNS = 'name, phone, oikoz_id, is_owner, is_makler, language, created_at'

/**
 * Compares without leaking the answer through how long it took. A plain ===
 * bails at the first wrong byte, which is enough to recover a secret one
 * character at a time.
 */
function timingSafeEqual(a: string, b: string): boolean {
  const encoder = new TextEncoder()
  const left = encoder.encode(a)
  const right = encoder.encode(b)
  const length = Math.max(left.length, right.length)

  let diff = left.length ^ right.length
  for (let i = 0; i < length; i++) {
    diff |= (left[i] ?? 0) ^ (right[i] ?? 0)
  }
  return diff === 0
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST') return json({ error: 'Use POST' }, 405)

  const expected = Deno.env.get('ADMIN_PANEL_PASSWORD') ?? ''

  // An unset secret must never behave like an empty password that anyone can
  // match. Refuse outright instead.
  if (!expected) {
    console.error('ADMIN_PANEL_PASSWORD is not set; refusing to serve the user list')
    return json({ error: 'Admin panel is not configured.' }, 503)
  }

  let supplied = ''
  try {
    const body = await req.json()
    supplied = typeof body?.password === 'string' ? body.password : ''
  } catch {
    supplied = ''
  }
  // A header works too, for anyone driving this with curl.
  if (!supplied) supplied = req.headers.get('X-Admin-Password') ?? ''

  if (!timingSafeEqual(supplied, expected)) {
    // Blunts online brute force a little. The real protection is a long
    // password, not this.
    await sleep(500)
    return json({ error: 'Incorrect password.' }, 401)
  }

  const admin = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
    { auth: { persistSession: false } },
  )

  const { data, error } = await admin
    .from('users')
    .select(COLUMNS)
    .order('created_at', { ascending: false })

  if (error) {
    console.error('user list query failed:', error.message)
    return json({ error: 'Could not load users.' }, 500)
  }

  return json({ users: data ?? [] })
})
