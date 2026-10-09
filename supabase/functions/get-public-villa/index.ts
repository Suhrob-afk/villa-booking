// ============================================================================
// get-public-villa -- everything the public booking page shows, for one villa.
//
// Request:  POST { initData, villa_code }
// Response: { villa, unavailable, today, visitor, hold }
//
//   villa        name, location, weekday/weekend price, currency, deposit,
//                capacity, owner display name, and whether it takes bookings
//                (an owner who has not entered a payout card cannot)
//   unavailable  merged [start, end) ranges: confirmed bookings, live holds
//                and owner blocks, from today on. Never which is which, never
//                a block reason, never anything about a guest.
//   today        today in Tashkent, so the page agrees with the server about
//                which days are past
//   visitor      whether the caller has a users row and a phone on file --
//                the page polls this while waiting for a shared contact
//   hold         the caller's OWN most recent hold on this villa, if it is
//                still worth showing. The card number is included only while
//                that hold is live.
//
// Never returned: payout card (outside the caller's live hold), client names
// or phones, block reasons, owner phone, telegram ids, internal villa id.
//
// Secrets: TELEGRAM_BOT_TOKEN. Injected: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.
// Deploy with --no-verify-jwt: the caller proves who they are with initData.
// ============================================================================

import {
  acceptPublicRequest,
  BOOKING_COLUMNS,
  fail,
  findVilla,
  findVisitor,
  ownerDisplayName,
  payoutCard,
  tashkentToday,
  toPublicHold,
  type BookingRow,
  type PublicHold,
} from '../_shared/public-booking.ts'
import { json } from '../_shared/http.ts'
import { isVillaCode } from '../_shared/telegram.ts'

const DAY_MS = 24 * 60 * 60 * 1000

interface Range {
  start: string
  end: string
}

/**
 * Sorts and joins overlapping or touching half-open ranges. Touching ones
 * merge too ([1,3) + [3,5) = [1,5)): the nights are identical, and it stops
 * the page from seeing where one guest's stay ends and the next begins.
 */
function mergeRanges(ranges: Range[]): Range[] {
  const sorted = [...ranges].sort((a, b) => a.start.localeCompare(b.start))
  const merged: Range[] = []
  for (const range of sorted) {
    const last = merged[merged.length - 1]
    if (last && range.start <= last.end) {
      if (range.end > last.end) last.end = range.end
    } else {
      merged.push({ ...range })
    }
  }
  return merged
}

/** Whether a visitor returning to the page should still see this hold. */
function worthShowing(hold: PublicHold, row: BookingRow, today: string): boolean {
  const recent = (iso: string) => Date.now() - Date.parse(iso) < DAY_MS
  switch (hold.status) {
    case 'pending':
      return true
    case 'expired':
      return recent(row.created_at)
    case 'cancelled':
    case 'rejected':
      return recent(row.updated_at)
    case 'confirmed':
      return row.check_out >= today
  }
}

Deno.serve(async (req) => {
  const accepted = await acceptPublicRequest<{ initData?: string; villa_code?: string }>(req)
  if (accepted instanceof Response) return accepted
  const { admin, telegram, body } = accepted

  if (!isVillaCode(body.villa_code)) return fail('not_found', 404)

  try {
    const villa = await findVilla(admin, body.villa_code)
    if (!villa) return fail('not_found', 404)

    const today = tashkentToday()
    const nowIso = new Date().toISOString()

    const [ownerName, card, visitor, bookings, blocks] = await Promise.all([
      ownerDisplayName(admin, villa.owner_id),
      payoutCard(admin, villa.id),
      findVisitor(admin, telegram.user.id),
      admin
        .from('bookings')
        .select('check_in, check_out')
        .eq('villa_id', villa.id)
        .gt('check_out', today)
        .or(`status.eq.confirmed,and(status.eq.pending,hold_expires_at.gt."${nowIso}")`),
      admin
        .from('blocked_dates')
        .select('start_date, end_date')
        .eq('villa_id', villa.id)
        .gt('end_date', today),
    ])

    if (bookings.error) throw new Error(bookings.error.message)
    if (blocks.error) throw new Error(blocks.error.message)

    const unavailable = mergeRanges([
      ...(bookings.data ?? []).map((b) => ({ start: b.check_in as string, end: b.check_out as string })),
      ...(blocks.data ?? []).map((b) => ({ start: b.start_date as string, end: b.end_date as string })),
    ])

    let hold: PublicHold | null = null
    if (visitor) {
      const { data: latest, error } = await admin
        .from('bookings')
        .select(BOOKING_COLUMNS)
        .eq('villa_id', villa.id)
        .eq('client_user_id', visitor.id)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle()
      if (error) throw new Error(error.message)
      if (latest) {
        const row = latest as BookingRow
        const candidate = toPublicHold(row, ownerName, card)
        if (worthShowing(candidate, row, today)) hold = candidate
      }
    }

    return json({
      villa: {
        name: villa.name,
        location: villa.location,
        weekday_price: Number(villa.weekday_price),
        weekend_price: Number(villa.weekend_price),
        currency: villa.currency.toUpperCase(),
        deposit_amount: Number(villa.deposit_amount),
        capacity: villa.capacity,
        owner_name: ownerName,
        accepting_bookings: card !== null,
      },
      unavailable,
      today,
      visitor: {
        registered: visitor !== null,
        has_phone: Boolean(visitor?.phone?.trim()),
      },
      hold,
    })
  } catch (err) {
    console.error('get-public-villa failed:', (err as Error).message)
    return fail('server', 500)
  }
})
