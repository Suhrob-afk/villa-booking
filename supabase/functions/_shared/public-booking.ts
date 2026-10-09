// ============================================================================
// What the three public-booking functions share: request plumbing, and the
// exact shapes a visitor is allowed to see.
//
// Everything leaving these functions is built here from an explicit field
// list. Nothing spreads a database row into a response, so a column added to
// villas or bookings later cannot leak onto the public page by accident.
// ============================================================================

import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4'
import { corsHeaders, json } from './http.ts'
import { verifyInitData, type VerifiedInitData } from './telegram.ts'

export type ErrorCode =
  | 'bad_request'
  | 'unauthorized'
  | 'not_found'
  | 'not_registered'
  | 'not_accepting'
  | 'phone_required'
  | 'invalid_dates'
  | 'too_many_holds'
  | 'dates_taken'
  | 'hold_not_live'
  | 'server'

/** `code` is what the page translates; `error` is for logs and curl. */
export function fail(code: ErrorCode, status: number, detail?: string): Response {
  return json({ code, error: detail ?? code }, status)
}

export interface PublicRequest<B> {
  admin: SupabaseClient
  telegram: VerifiedInitData
  body: B
}

/**
 * Method, configuration, body and initData checks common to every public
 * endpoint. Returns a ready Response when the request stops here.
 *
 * Only real, signed initData is accepted -- there is deliberately no
 * development bypass on these functions.
 */
export async function acceptPublicRequest<B extends { initData?: unknown }>(
  req: Request,
): Promise<PublicRequest<B> | Response> {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST') return fail('bad_request', 405, 'Use POST')

  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  const botToken = Deno.env.get('TELEGRAM_BOT_TOKEN')
  if (!supabaseUrl || !serviceKey || !botToken) {
    return fail('server', 500, 'Edge Function is missing SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY or TELEGRAM_BOT_TOKEN')
  }

  let body: B
  try {
    body = (await req.json()) as B
  } catch {
    return fail('bad_request', 400, 'Body must be JSON')
  }

  if (typeof body?.initData !== 'string' || !body.initData) {
    return fail('unauthorized', 401, 'Open this page from Telegram.')
  }

  let telegram: VerifiedInitData
  try {
    telegram = await verifyInitData(body.initData, botToken)
  } catch (err) {
    return fail('unauthorized', 401, (err as Error).message)
  }

  const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } })
  return { admin, telegram, body }
}

// ------------------------------------------------------------------ dates ----

/** Today's date in Uzbekistan, as YYYY-MM-DD. The database uses the same. */
export function tashkentToday(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tashkent',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date())
}

export function isISODate(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
}

// ---------------------------------------------------------------- lookups ----

export interface VisitorRow {
  id: string
  phone: string | null
}

export async function findVisitor(admin: SupabaseClient, telegramId: number): Promise<VisitorRow | null> {
  const { data, error } = await admin
    .from('users')
    .select('id, phone')
    .eq('telegram_id', telegramId)
    .maybeSingle()
  if (error) throw new Error(error.message)
  return (data as VisitorRow | null) ?? null
}

export interface VillaRow {
  id: string
  owner_id: string
  name: string
  location: string | null
  weekday_price: number
  weekend_price: number
  currency: string
  deposit_amount: number
  capacity: number | null
}

/** A live (not archived) villa by its public code, or null. */
export async function findVilla(admin: SupabaseClient, villaCode: string): Promise<VillaRow | null> {
  const { data, error } = await admin
    .from('villas')
    .select('id, owner_id, name, location, weekday_price, weekend_price, currency, deposit_amount, capacity')
    .eq('villa_code', villaCode)
    .is('archived_at', null)
    .maybeSingle()
  if (error) throw new Error(error.message)
  return (data as VillaRow | null) ?? null
}

export async function ownerDisplayName(admin: SupabaseClient, ownerId: string): Promise<string> {
  const { data } = await admin.from('users').select('full_name, name').eq('id', ownerId).maybeSingle()
  return ((data?.full_name as string | null)?.trim() || (data?.name as string | null)?.trim() || '') as string
}

/** The owner's card. Only ever sent to the visitor holding a live hold. */
export async function payoutCard(admin: SupabaseClient, villaId: string): Promise<string | null> {
  const { data } = await admin.from('villa_payout_details').select('card_number').eq('villa_id', villaId).maybeSingle()
  return (data?.card_number as string | undefined) ?? null
}

// ------------------------------------------------------------------ holds ----

export interface BookingRow {
  id: string
  villa_id: string
  status: 'confirmed' | 'cancelled' | 'pending' | 'expired'
  check_in: string
  check_out: string
  total_price: number
  currency: 'uzs' | 'usd'
  deposit_amount: number
  hold_expires_at: string | null
  client_marked_paid_at: string | null
  created_at: string
  updated_at: string
}

export const BOOKING_COLUMNS =
  'id, villa_id, status, check_in, check_out, total_price, currency, deposit_amount, hold_expires_at, client_marked_paid_at, created_at, updated_at'

/** A visitor's own hold, as the page sees it. */
export interface PublicHold {
  id: string
  /** 'expired' also covers a pending row past its expiry that the sweep has not reached. */
  status: 'pending' | 'expired' | 'confirmed' | 'cancelled'
  check_in: string
  check_out: string
  total_price: number
  /** ISO code, e.g. "UZS". total_price is in this; the deposit is always UZS. */
  currency: string
  deposit_amount: number
  marked_paid: boolean
  /** Seconds until the hold lapses, as of this response. Null unless pending. */
  seconds_left: number | null
  /** Only while pending. */
  card_number: string | null
  owner_name: string
}

export function isLiveHold(row: Pick<BookingRow, 'status' | 'hold_expires_at'>, now = Date.now()): boolean {
  return row.status === 'pending' && row.hold_expires_at !== null && Date.parse(row.hold_expires_at) > now
}

export function toPublicHold(row: BookingRow, ownerName: string, card: string | null): PublicHold {
  const now = Date.now()
  const live = isLiveHold(row, now)
  const status: PublicHold['status'] = row.status === 'pending' && !live ? 'expired' : row.status
  return {
    id: row.id,
    status,
    check_in: row.check_in,
    check_out: row.check_out,
    total_price: Number(row.total_price),
    currency: row.currency.toUpperCase(),
    deposit_amount: Number(row.deposit_amount),
    marked_paid: row.client_marked_paid_at !== null,
    seconds_left: live ? Math.max(0, Math.floor((Date.parse(row.hold_expires_at!) - now) / 1000)) : null,
    card_number: live ? card : null,
    owner_name: ownerName,
  }
}

/** 'oikoz:dates_taken' raised by create_public_hold() -> 'dates_taken'. */
export function raisedCode(message: string | undefined): ErrorCode | null {
  const match = /oikoz:([a-z_]+)/.exec(message ?? '')
  return match ? (match[1] as ErrorCode) : null
}
