// ============================================================================
// create-public-booking -- a visitor on the public page reserves dates.
//
// Request:  POST { initData, villa_code, check_in, check_out,
//                  client_name, guests, client_type, note? }
// Response: { hold }   -- the new 30-minute hold, with the owner's card number
//                         and display name, for this visitor only
// Errors:   { code }   -- not_registered, phone_required, not_found,
//                         not_accepting, invalid_dates, invalid_details,
//                         too_many_guests, too_many_holds, dates_taken
//
// The insert and every rule live in public.create_public_hold() (the
// eight-argument version from migration 0021), which only service_role may
// execute. The shape checks below only stop obviously malformed input early;
// the database re-checks every detail, guests against the villa's capacity
// (or 30 when it has none) included. App users cannot create holds
// at all (bookings_status_guard), so this function is the only way in.
//
// Price, currency, deposit, credited makler and the visitor's phone are all
// read server-side. From the client come only the villa code, the dates and
// the form: name, guests, client type and an optional note.
//
// The owner is NOT messaged here. They get one message per booking, when the
// guest taps "I've sent the deposit" (mark-deposit-sent).
//
// Secrets: TELEGRAM_BOT_TOKEN. Injected: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.
// Deploy with --no-verify-jwt: the caller proves who they are with initData.
// ============================================================================

import {
  acceptPublicRequest,
  fail,
  findVisitor,
  isISODate,
  ownerDisplayName,
  payoutCard,
  raisedCode,
  toPublicHold,
  type BookingRow,
  type ErrorCode,
} from '../_shared/public-booking.ts'
import { json } from '../_shared/http.ts'
import { isVillaCode } from '../_shared/telegram.ts'

const STATUS: Partial<Record<ErrorCode, number>> = {
  not_found: 404,
  not_accepting: 409,
  phone_required: 409,
  invalid_dates: 400,
  invalid_details: 400,
  too_many_guests: 400,
  too_many_holds: 429,
  dates_taken: 409,
}

Deno.serve(async (req) => {
  const accepted = await acceptPublicRequest<{
    initData?: string
    villa_code?: string
    check_in?: string
    check_out?: string
    client_name?: unknown
    guests?: unknown
    client_type?: unknown
    note?: unknown
  }>(req)
  if (accepted instanceof Response) return accepted
  const { admin, telegram, body } = accepted

  if (!isVillaCode(body.villa_code)) return fail('not_found', 404)
  if (!isISODate(body.check_in) || !isISODate(body.check_out)) return fail('invalid_dates', 400)
  if (
    typeof body.client_name !== 'string' ||
    body.client_name.length > 200 ||
    typeof body.guests !== 'number' ||
    !Number.isInteger(body.guests) ||
    typeof body.client_type !== 'string' ||
    (body.note !== undefined && body.note !== null && (typeof body.note !== 'string' || body.note.length > 1000))
  ) {
    return fail('invalid_details', 400)
  }

  try {
    // telegram-auth creates the visitor's row when the page opens; without one
    // there is nobody to hold the dates for.
    const visitor = await findVisitor(admin, telegram.user.id)
    if (!visitor) return fail('not_registered', 409)

    const { data, error } = await admin.rpc('create_public_hold', {
      p_client_user_id: visitor.id,
      p_villa_code: body.villa_code,
      p_check_in: body.check_in,
      p_check_out: body.check_out,
      p_client_name: body.client_name,
      p_guests: body.guests,
      p_client_type: body.client_type,
      p_note: typeof body.note === 'string' ? body.note : null,
    })

    if (error) {
      const code = raisedCode(error.message)
      if (code && STATUS[code]) return fail(code, STATUS[code]!)
      console.error('create_public_hold failed:', error.message)
      return fail('server', 500)
    }

    const row = data as BookingRow
    const { data: villa } = await admin.from('villas').select('owner_id').eq('id', row.villa_id).single()
    const [ownerName, card] = await Promise.all([
      ownerDisplayName(admin, villa!.owner_id as string),
      payoutCard(admin, row.villa_id),
    ])

    return json({ hold: toPublicHold(row, ownerName, card) })
  } catch (err) {
    console.error('create-public-booking failed:', (err as Error).message)
    return fail('server', 500)
  }
})
