// ============================================================================
// link-manager — links a manager to a villa by their oikoz_id, then notifies
// them on Telegram. Wraps public.link_manager_by_oikoz_id() rather than
// having the client call the RPC directly, because the notification step
// needs the manager's telegram_id, which is never exposed to the client
// (see 0003_multi_role_oikoz_id.sql).
//
// The authorization check (only the villa's owner may do this) is NOT
// reimplemented here -- the RPC call below runs through PostgREST with the
// caller's own JWT, so the same RLS/SECURITY DEFINER logic used everywhere
// else in the app applies unchanged.
//
// Secrets: reuses TELEGRAM_BOT_TOKEN, already set for telegram-auth.
// Injected automatically: SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY
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

/** Best-effort DM to the newly-linked manager. Never throws. */
async function notifyManager(opts: {
  supabaseUrl: string
  serviceKey: string
  botToken: string
  villaId: string
  managerId: string
}): Promise<void> {
  try {
    const admin = createClient(opts.supabaseUrl, opts.serviceKey, { auth: { persistSession: false } })

    const { data: villa } = await admin.from('villas').select('name, owner_id').eq('id', opts.villaId).maybeSingle()
    if (!villa) return

    const [{ data: managerRow }, { data: ownerRow }] = await Promise.all([
      admin.from('users').select('telegram_id').eq('id', opts.managerId).maybeSingle(),
      admin.from('users').select('name').eq('id', villa.owner_id).maybeSingle(),
    ])

    const telegramId = managerRow?.telegram_id
    if (!telegramId) return

    const ownerName = ownerRow?.name || 'The owner'
    const text = `You've been added as a manager on ${villa.name} by ${ownerName}. Open Villa CRM to see it.`
    await fetch(`https://api.telegram.org/bot${opts.botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: telegramId, text }),
    })
  } catch (err) {
    console.error('link-manager notification failed:', (err as Error).message)
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST') return json({ error: 'Use POST' }, 405)

  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY')
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  const botToken = Deno.env.get('TELEGRAM_BOT_TOKEN')

  const missing = [
    ['SUPABASE_URL', supabaseUrl],
    ['SUPABASE_ANON_KEY', anonKey],
    ['SUPABASE_SERVICE_ROLE_KEY', serviceKey],
  ].filter(([, value]) => !value).map(([name]) => name)
  if (missing.length > 0) return json({ error: `Edge Function is missing ${missing.join(', ')}` }, 500)

  const authHeader = req.headers.get('Authorization')
  if (!authHeader) return json({ error: 'Missing Authorization header' }, 401)

  let body: { villaId?: string; oikozId?: string }
  try {
    body = await req.json()
  } catch {
    return json({ error: 'Body must be JSON' }, 400)
  }
  const villaId = body.villaId?.trim()
  const oikozId = body.oikozId?.trim()
  if (!villaId || !oikozId) return json({ error: 'villaId and oikozId are required' }, 400)

  // Runs as the caller: RLS + link_manager_by_oikoz_id's own owner check decide access.
  const asCaller = createClient(supabaseUrl!, anonKey!, {
    auth: { persistSession: false },
    global: { headers: { Authorization: authHeader } },
  })

  const { data: manager, error: linkError } = await asCaller
    .rpc('link_manager_by_oikoz_id', { p_villa_id: villaId, p_oikoz_id: oikozId })
    .single()

  if (linkError) return json({ error: linkError.message }, 400)

  const typedManager = manager as { id: string }
  if (botToken) {
    // Awaited (not fire-and-forget): the edge runtime can freeze the isolate
    // right after the response is sent, so a detached promise here might
    // never actually run. notifyManager() never throws either way.
    await notifyManager({ supabaseUrl: supabaseUrl!, serviceKey: serviceKey!, botToken, villaId, managerId: typedManager.id })
  }

  return json({ manager })
})
