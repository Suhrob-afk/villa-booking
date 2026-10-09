// ============================================================================
// get-public-villa -- everything the public booking page shows, for one villa.
//
// Request:  POST { initData, villa_code }
// Response: { villa, unavailable, today, visitor, my_bookings, latest_id }
//
//   villa        name, location, weekday/weekend price, currency, deposit,
//                capacity, owner display name, and whether it takes bookings
//                (an owner who has not entered a payout card cannot)
//   unavailable  merged [start, end) ranges taken by OTHER people: confirmed
//                bookings, live holds and owner blocks, from today on. Never
//                which is which, never a block reason, never anything about a
//                guest. The caller's own bookings are left out of it and sent
//                in my_bookings instead, so the page can colour them.
//   today        today in Tashkent, so the page agrees with the server about
//                which days are past
//   visitor      whether the caller has a users row, their phone (their own,
//                shown back as "saved") and a name to pre-fill the form with --
//                the page polls this while waiting for a shared contact
//   my_bookings  the caller's OWN bookings on this villa that are still worth
//                showing: live holds, upcoming confirmed stays, and holds that
//                lapsed, were rejected or were cancelled in the last day. The
//                card number rides only on a live hold not yet marked paid.
//   latest_id    which of those the page's status line is about: the newest
//                live hold, else the most recently changed booking
//
// Never returned: payout card (outside the caller's live, unpaid hold), other
// guests' names or phones, block reasons, owner phone, telegram ids, internal
// villa id.
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
import { isVillaCode, telegramDisplayName } from '../_shared/telegram.ts'

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

/** Whether a visitor returning to the page should still see this booking. */
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
      // client_user_id is read only to separate the caller's own nights from
      // everyone else's; it never leaves this function.
      admin
        .from('bookings')
        .select('check_in, check_out, client_user_id')
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
      ...(bookings.data ?? [])
        .filter((b) => !visitor || b.client_user_id !== visitor.id)
        .map((b) => ({ start: b.check_in as string, end: b.check_out as string })),
      ...(blocks.data ?? []).map((b) => ({ start: b.start_date as string, end: b.end_date as string })),
    ])

    const myBookings: PublicHold[] = []
    let latestId: string | null = null
    if (visitor) {
      const { data: rows, error } = await admin
        .from('bookings')
        .select(BOOKING_COLUMNS)
        .eq('villa_id', villa.id)
        .eq('client_user_id', visitor.id)
        .order('created_at', { ascending: false })
        .limit(30)
      if (error) throw new Error(error.message)

      // Newest first, so the first live hold met is the newest one.
      let latestChange = ''
      for (const row of (rows ?? []) as BookingRow[]) {
        const booking = toPublicHold(row, ownerName, card)
        if (!worthShowing(booking, row, today)) continue
        myBookings.push(booking)
        if (row.updated_at > latestChange) {
          latestChange = row.updated_at
          latestId = booking.id
        }
      }
      // A live hold is what the guest is acting on right now; it wins.
      latestId = myBookings.find((b) => b.status === 'pending')?.id ?? latestId
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
        phone: visitor?.phone?.trim() || null,
        name: visitor?.full_name?.trim() || visitor?.name?.trim() || telegramDisplayName(telegram.user),
      },
      my_bookings: myBookings,
      latest_id: latestId,
    })
  } catch (err) {
    console.error('get-public-villa failed:', (err as Error).message)
    return fail('server', 500)
  }
})
