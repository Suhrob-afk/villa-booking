// ============================================================================
// exchange-rate — today's USD/UZS rate from the Central Bank of Uzbekistan,
// read through a cache so the screens never hit cbu.uz on every load.
//
//   cached row is from today -> return it, no outbound call
//   otherwise               -> fetch cbu.uz, store it, return it
//   cbu.uz unreachable      -> return the last rate we stored, marked stale
//   nothing stored at all   -> 503, and the client simply drops the combined
//                              total rather than showing a wrong one
//
// The rate is public information, so this deploys with --no-verify-jwt like
// the other two functions. It only ever reads from the bank and writes one
// row; it exposes nothing about any user.
//
// Injected automatically: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
// ============================================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

const CODE = 'USD'
const CBU_URL = 'https://cbu.uz/en/arkhiv-kursov-valyut/json/USD/'

const admin = createClient(
  Deno.env.get('SUPABASE_URL') ?? '',
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
  { auth: { persistSession: false } },
)

/** Tashkent is UTC+5 and the bank publishes on its own calendar day. */
function todayInTashkent(): string {
  return new Date(Date.now() + 5 * 60 * 60 * 1000).toISOString().slice(0, 10)
}

/** The bank returns "DD.MM.YYYY"; everything here speaks ISO. */
function parseBankDate(value: string): string | null {
  const match = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(value?.trim() ?? '')
  return match ? `${match[3]}-${match[2]}-${match[1]}` : null
}

interface Stored {
  code: string
  rate: number
  rate_date: string
  fetched_at: string
}

async function readStored(): Promise<Stored | null> {
  const { data } = await admin.from('exchange_rates').select('*').eq('code', CODE).maybeSingle()
  return (data as Stored | null) ?? null
}

/** Never throws: a bank outage must not take the screens down with it. */
async function fetchFromBank(): Promise<{ rate: number; rateDate: string } | null> {
  try {
    // Bounded, so a hanging bank does not hold the request open.
    const abort = AbortSignal.timeout(8000)
    const response = await fetch(CBU_URL, { signal: abort, headers: { Accept: 'application/json' } })
    if (!response.ok) {
      console.error(`cbu.uz returned ${response.status}`)
      return null
    }

    const body = await response.json()
    const row = Array.isArray(body) ? body[0] : null
    const rate = Number(row?.Rate)
    const nominal = Number(row?.Nominal ?? '1') || 1
    const rateDate = parseBankDate(row?.Date ?? '')

    if (!Number.isFinite(rate) || rate <= 0 || !rateDate) {
      console.error('cbu.uz returned an unusable payload:', JSON.stringify(body)?.slice(0, 300))
      return null
    }
    // Nominal is 1 for USD, but honouring it keeps this correct for any other
    // currency the bank quotes per 10 or per 100 units.
    return { rate: rate / nominal, rateDate }
  } catch (err) {
    console.error('cbu.uz fetch failed:', (err as Error).message)
    return null
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  const stored = await readStored()
  const today = todayInTashkent()

  // Fresh enough: we already fetched at some point today.
  if (stored && stored.fetched_at.slice(0, 10) === today) {
    return json({ code: CODE, rate: Number(stored.rate), rateDate: stored.rate_date, stale: false })
  }

  const fresh = await fetchFromBank()

  if (!fresh) {
    // Serving yesterday's number, honestly labelled, beats serving none.
    if (stored) {
      return json({ code: CODE, rate: Number(stored.rate), rateDate: stored.rate_date, stale: true })
    }
    return json({ error: 'No exchange rate available' }, 503)
  }

  const { error } = await admin.from('exchange_rates').upsert(
    { code: CODE, rate: fresh.rate, rate_date: fresh.rateDate, fetched_at: new Date().toISOString() },
    { onConflict: 'code' },
  )
  // A failed write only costs us the cache, not the answer.
  if (error) console.error('exchange_rates upsert failed:', error.message)

  return json({ code: CODE, rate: fresh.rate, rateDate: fresh.rateDate, stale: false })
})
