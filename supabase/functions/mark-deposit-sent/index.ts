// ============================================================================
// mark-deposit-sent -- the visitor taps "I've sent the deposit".
//
// Request:  POST { initData, booking_id }
// Response: { hold }   -- the hold as it now stands
// Errors:   { code: 'hold_not_live', hold? } when the hold has lapsed or been
//           resolved; { code: 'not_found' } when it is not this visitor's.
//
// Sets client_marked_paid_at and, on the first tap only, extends the hold to
// two hours from now so the owner has time to check their card. It never sets
// deposit_paid: only the owner confirming receipt does that (Phase 3).
// The rules are in public.mark_public_hold_paid() (migration 0018).
//
// Secrets: TELEGRAM_BOT_TOKEN. Injected: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.
// Deploy with --no-verify-jwt: the caller proves who they are with initData.
// ============================================================================

import {
  acceptPublicRequest,
  BOOKING_COLUMNS,
  fail,
  findVisitor,
  ownerDisplayName,
  payoutCard,
  toPublicHold,
  type BookingRow,
} from '../_shared/public-booking.ts'
import { json } from '../_shared/http.ts'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

Deno.serve(async (req) => {
  const accepted = await acceptPublicRequest<{ initData?: string; booking_id?: string }>(req)
  if (accepted instanceof Response) return accepted
  const { admin, telegram, body } = accepted

  if (typeof body.booking_id !== 'string' || !UUID_RE.test(body.booking_id)) return fail('not_found', 404)

  try {
    const visitor = await findVisitor(admin, telegram.user.id)
    if (!visitor) return fail('not_found', 404)

    const { data: updated, error } = await admin.rpc('mark_public_hold_paid', {
      p_client_user_id: visitor.id,
      p_booking_id: body.booking_id,
    })
    if (error) throw new Error(error.message)

    // No row updated: read it back (scoped to this visitor) to say why.
    let row = ((updated as BookingRow[] | null) ?? [])[0] ?? null
    let live = row !== null
    if (!row) {
      const { data: current, error: readError } = await admin
        .from('bookings')
        .select(BOOKING_COLUMNS)
        .eq('id', body.booking_id)
        .eq('client_user_id', visitor.id)
        .maybeSingle()
      if (readError) throw new Error(readError.message)
      if (!current) return fail('not_found', 404)
      row = current as BookingRow
      live = false
    }

    const { data: villa } = await admin.from('villas').select('owner_id').eq('id', row.villa_id).single()
    const [ownerName, card] = await Promise.all([
      ownerDisplayName(admin, villa!.owner_id as string),
      payoutCard(admin, row.villa_id),
    ])
    const hold = toPublicHold(row, ownerName, card)

    if (!live) return json({ code: 'hold_not_live', error: 'hold_not_live', hold }, 409)
    return json({ hold })
  } catch (err) {
    console.error('mark-deposit-sent failed:', (err as Error).message)
    return fail('server', 500)
  }
})
