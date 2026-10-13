// ============================================================================
// A guest's deposit receipt, for a booking made on the public page.
//
//   1. "I've sent the deposit" on the page opens t.me/oikoz_villa_bot?start=
//      dr_<booking id>. startReceiptRequest() checks the booking is THIS
//      Telegram user's own live hold, not yet marked sent, and only then
//      names it back (villa, dates, amount) and asks for the screenshot, with
//      a "Send without receipt" button. Any failed check gets one generic
//      reply that does not say whether the booking exists: ids can be shared
//      or guessed.
//   2. The screenshot (a photo, or an image sent as a file) goes to the
//      private receipts bucket under deposits/<booking_id>/, then
//      submit_deposit_receipt() (migration 0025) marks the hold sent and
//      extends it, and the owner gets ONE message: the screenshot with the
//      booking's details and Deposit received / Not received.
//   3. "Send without receipt" does the same with no image; the owner's
//      message says so.
//
// Which booking a screenshot is for: the one the guest's latest deep link
// (or pick) named, remembered in deposit_receipt_requests. With nothing
// named, a screenshot goes to the guest's only booking waiting for one; with
// two waiting, the bot asks which.
//
// The receipt is evidence for the owner, never a confirmation. Nothing here
// touches status or deposit_paid.
// ============================================================================

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4'
import {
  bookingLink,
  botCall,
  escapeHtml,
  formatUzs,
  loadBookingContext,
  notifyOwner,
  stay,
} from '../_shared/owner-bot.ts'
import type { IncomingReceipt } from '../_shared/payments/provider.ts'
import { MAX_RECEIPT_BYTES, receiptExtension, storeTelegramImage } from '../_shared/receipts.ts'
import { COPY, isLang, type Lang } from './copy.ts'

type Json = Record<string, unknown>

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
/** "/start dr_<booking id>": 39 characters of start parameter, under Telegram's 64. */
const START_RE = new RegExp(`^/start\\s+dr_(${UUID})$`, 'i')
/** "dr:none:<id>" Send without receipt; "dr:pick:<id>" this booking. At most 44 bytes. */
const CALLBACK_RE = new RegExp(`^dr:(none|pick):(${UUID})$`)

export type ReceiptAction = 'none' | 'pick'

/** The booking id a deep link names, or null if the message is not one. */
export function parseReceiptStart(text: string): string | null {
  return START_RE.exec(text)?.[1]?.toLowerCase() ?? null
}

export function parseReceiptCallback(data: string): { action: ReceiptAction; bookingId: string } | null {
  const match = CALLBACK_RE.exec(data)
  return match ? { action: match[1] as ReceiptAction, bookingId: match[2] } : null
}

// ---------------------------------------------------------------- lookups ----

interface Guest {
  id: string
  lang: Lang
}

async function guestOf(admin: SupabaseClient, telegramId: number): Promise<Guest | null> {
  const { data } = await admin.from('users').select('id, language').eq('telegram_id', telegramId).maybeSingle()
  return data ? { id: data.id as string, lang: isLang(data.language) ? (data.language as Lang) : 'en' } : null
}

interface HoldRow {
  id: string
  status: string
  hold_expires_at: string | null
  client_marked_paid_at: string | null
  deposit_not_received_count: number
  created_at: string
}

const HOLD_COLUMNS = 'id, status, hold_expires_at, client_marked_paid_at, deposit_not_received_count, created_at'

/**
 * The booking, only if this guest made it. Everything that shows a booking's
 * details to a Telegram user goes through here first.
 */
async function ownBooking(admin: SupabaseClient, guestId: string, bookingId: string): Promise<HoldRow | null> {
  const { data, error } = await admin
    .from('bookings')
    .select(HOLD_COLUMNS)
    .eq('id', bookingId)
    .eq('client_user_id', guestId)
    .maybeSingle()
  if (error) throw new Error(error.message)
  return (data as HoldRow | null) ?? null
}

const isLive = (b: HoldRow) =>
  b.status === 'pending' && b.hold_expires_at !== null && Date.parse(b.hold_expires_at) > Date.now()

/** A live hold the guest has not yet said they paid for: the only kind that takes a receipt. */
const awaitsReceipt = (b: HoldRow) => isLive(b) && b.client_marked_paid_at === null

/** All of the guest's holds waiting for a receipt, newest first. */
async function holdsAwaitingReceipt(admin: SupabaseClient, guestId: string): Promise<HoldRow[]> {
  const { data, error } = await admin
    .from('bookings')
    .select(HOLD_COLUMNS)
    .eq('client_user_id', guestId)
    .eq('status', 'pending')
    .gt('hold_expires_at', new Date().toISOString())
    .is('client_marked_paid_at', null)
    .order('created_at', { ascending: false })
  if (error) throw new Error(error.message)
  return (data as HoldRow[] | null) ?? []
}

async function rememberRequest(admin: SupabaseClient, telegramId: number, bookingId: string): Promise<void> {
  const { error } = await admin
    .from('deposit_receipt_requests')
    .upsert({ telegram_id: telegramId, booking_id: bookingId, requested_at: new Date().toISOString() }, {
      onConflict: 'telegram_id',
    })
  if (error) throw new Error(error.message)
}

async function forgetRequest(admin: SupabaseClient, telegramId: number): Promise<void> {
  await admin.from('deposit_receipt_requests').delete().eq('telegram_id', telegramId)
}

/** When the guest last asked to send a deposit receipt, or null. Decides precedence over /subscribe. */
export async function depositRequestedAt(admin: SupabaseClient, telegramId: number): Promise<number | null> {
  const { data } = await admin
    .from('deposit_receipt_requests')
    .select('requested_at')
    .eq('telegram_id', telegramId)
    .maybeSingle()
  return data?.requested_at ? Date.parse(data.requested_at as string) : null
}

// -------------------------------------------------------------- messages ----

const say = (chatId: number, text: string, replyMarkup?: Json) =>
  botCall('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', ...(replyMarkup ? { reply_markup: replyMarkup } : {}) })

const withoutReceiptKeyboard = (lang: Lang, bookingId: string): Json => ({
  inline_keyboard: [[{ text: COPY[lang].depositSendWithout, callback_data: `dr:none:${bookingId}` }]],
})

/** Villa and dates of a booking already checked to be the guest's own. */
async function summary(admin: SupabaseClient, bookingId: string, lang: Lang) {
  const ctx = await loadBookingContext(admin, bookingId)
  if (!ctx) return null
  return {
    /** For message text (HTML). */
    villa: escapeHtml(ctx.villaName),
    /** For button labels, which are plain text. */
    villaPlain: ctx.villaName,
    dates: stay(ctx.booking, lang),
    amount: formatUzs(ctx.booking.deposit_amount),
    openBooking: { inline_keyboard: [[{ text: COPY[lang].openBooking, url: bookingLink(ctx.villaCode) }]] } as Json,
  }
}

/** Why a guest's own booking takes no receipt now, said with the way back to the page. */
async function explainNotAwaiting(admin: SupabaseClient, chatId: number, booking: HoldRow, lang: Lang): Promise<void> {
  const about = await summary(admin, booking.id, lang)
  const text = isLive(booking) && booking.client_marked_paid_at ? COPY[lang].depositAlreadySent : COPY[lang].depositHoldEnded
  await say(chatId, text, about?.openBooking)
}

// ------------------------------------------------------------- the link ----

/**
 * /start dr_<booking id>. Ownership is checked before anything about the
 * booking is said: an unknown id, someone else's booking and a malformed one
 * all get the same generic reply.
 */
export async function startReceiptRequest(
  admin: SupabaseClient,
  chatId: number,
  telegramId: number,
  bookingId: string,
): Promise<void> {
  const guest = await guestOf(admin, telegramId)
  const booking = guest ? await ownBooking(admin, guest.id, bookingId) : null
  const lang = guest?.lang ?? 'en'
  if (!guest || !booking) {
    await say(chatId, COPY[lang].depositLinkInvalid)
    return
  }

  if (!awaitsReceipt(booking)) {
    await explainNotAwaiting(admin, chatId, booking, lang)
    return
  }

  const about = await summary(admin, booking.id, lang)
  if (!about) {
    await say(chatId, COPY[lang].depositLinkInvalid)
    return
  }
  await rememberRequest(admin, telegramId, booking.id)
  await say(chatId, COPY[lang].depositReceiptAsk(about.villa, about.dates, about.amount), withoutReceiptKeyboard(lang, booking.id))
}

// ------------------------------------------------------- the screenshot ----

/**
 * A message from a guest that may be a deposit receipt. Returns false when it
 * is not about one, so the ordinary conversation carries on.
 *
 *   - a booking named by the guest's latest link or pick, still waiting: this
 *     message is for it. A screenshot is taken; anything else is asked again.
 *   - nothing named: a photo or file goes to the guest's one booking waiting
 *     for a receipt; with two, the bot asks which; with none, it is not a
 *     receipt. Plain text is left to the conversation.
 */
export async function handleDepositReceipt(
  admin: SupabaseClient,
  chatId: number,
  telegramId: number,
  receipt: IncomingReceipt | null,
): Promise<boolean> {
  const guest = await guestOf(admin, telegramId)
  if (!guest) return false
  const lang = guest.lang

  let target: HoldRow | null = null
  const { data: request } = await admin
    .from('deposit_receipt_requests')
    .select('booking_id')
    .eq('telegram_id', telegramId)
    .maybeSingle()
  if (request) {
    const named = await ownBooking(admin, guest.id, request.booking_id as string)
    if (named && awaitsReceipt(named)) target = named
    else await forgetRequest(admin, telegramId)
  }

  if (!target) {
    if (!receipt) return false
    const waiting = await holdsAwaitingReceipt(admin, guest.id)
    if (waiting.length === 0) return false
    if (waiting.length > 1) {
      await askWhichBooking(admin, chatId, waiting, lang)
      return true
    }
    target = waiting[0]
  }

  // Not an image the bucket takes (a PDF, a voice note, text...): ask again,
  // and keep "Send without receipt" in reach.
  if (!receipt || !receiptExtension(receipt.contentType)) {
    await say(chatId, COPY[lang].depositReceiptAskAgain, withoutReceiptKeyboard(lang, target.id))
    return true
  }
  if (receipt.sizeBytes !== null && receipt.sizeBytes > MAX_RECEIPT_BYTES) {
    await say(chatId, COPY[lang].depositReceiptTooLarge, withoutReceiptKeyboard(lang, target.id))
    return true
  }

  // One file per attempt and upload, never overwritten: a retry after Not
  // received keeps the earlier screenshot beside the new one.
  const path = `deposits/${target.id}/${target.deposit_not_received_count}-${Date.now()}.${receiptExtension(receipt.contentType)}`
  if (!(await storeTelegramImage(admin, receipt.telegramFileId, path, receipt.contentType, 'deposit-receipt'))) {
    await say(chatId, COPY[lang].depositReceiptFailed, withoutReceiptKeyboard(lang, target.id))
    return true
  }

  await submit(admin, chatId, telegramId, guest, target.id, { path, receipt })
  return true
}

async function askWhichBooking(admin: SupabaseClient, chatId: number, waiting: HoldRow[], lang: Lang): Promise<void> {
  const rows: Json[][] = []
  for (const hold of waiting) {
    const about = await summary(admin, hold.id, lang)
    if (about) rows.push([{ text: `${about.villaPlain} · ${about.dates}`, callback_data: `dr:pick:${hold.id}` }])
  }
  await say(chatId, COPY[lang].depositReceiptWhich, { inline_keyboard: rows })
}

/**
 * Marks the hold sent (with the stored receipt, or none) and tells the owner
 * and the guest. If the hold was marked or ended in the meantime, nothing is
 * sent to the owner and a stored file is removed again.
 */
async function submit(
  admin: SupabaseClient,
  chatId: number,
  telegramId: number,
  guest: Guest,
  bookingId: string,
  stored: { path: string; receipt: IncomingReceipt } | null,
): Promise<void> {
  const lang = guest.lang
  const { data, error } = await admin.rpc('submit_deposit_receipt', {
    p_client_user_id: guest.id,
    p_booking_id: bookingId,
    p_receipt_path: stored?.path ?? null,
  })
  if (error) {
    console.error(`[deposit-receipt] submit failed for booking ${bookingId}: ${error.message}`)
    if (stored) await admin.storage.from('receipts').remove([stored.path])
    await say(chatId, COPY[lang].depositReceiptFailed, withoutReceiptKeyboard(lang, bookingId))
    return
  }

  const row = ((data as { deposit_not_received_count: number }[] | null) ?? [])[0]
  if (!row) {
    if (stored) await admin.storage.from('receipts').remove([stored.path])
    await forgetRequest(admin, telegramId)
    const booking = await ownBooking(admin, guest.id, bookingId)
    if (booking) await explainNotAwaiting(admin, chatId, booking, lang)
    return
  }

  await forgetRequest(admin, telegramId)
  // One owner message per attempt (booking_owner_messages), so a second
  // submission for the same attempt could never reach them twice anyway.
  await notifyOwner(
    admin,
    bookingId,
    'deposit_sent',
    row.deposit_not_received_count,
    stored ? { telegramFileId: stored.receipt.telegramFileId, kind: stored.receipt.kind } : null,
  )
  const about = await summary(admin, bookingId, lang)
  await say(chatId, stored ? COPY[lang].depositReceiptReceived : COPY[lang].depositSentWithout, about?.openBooking)
}

// -------------------------------------------------------------- buttons ----

/**
 * "Send without receipt" and the which-booking buttons. Only the guest who
 * made the booking can use them; anyone else's tap is answered silently.
 */
export async function handleReceiptCallback(
  admin: SupabaseClient,
  callbackId: string,
  tapperId: number,
  message: { chat: { id: number }; message_id: number },
  action: ReceiptAction,
  bookingId: string,
): Promise<void> {
  await botCall('answerCallbackQuery', { callback_query_id: callbackId })
  const guest = await guestOf(admin, tapperId)
  const booking = guest ? await ownBooking(admin, guest.id, bookingId) : null
  if (!guest || !booking) return

  // Retire this message's buttons, so the choice cannot be made twice.
  await botCall('editMessageReplyMarkup', {
    chat_id: message.chat.id,
    message_id: message.message_id,
    reply_markup: { inline_keyboard: [] },
  })

  if (!awaitsReceipt(booking)) {
    await explainNotAwaiting(admin, message.chat.id, booking, guest.lang)
    return
  }

  if (action === 'pick') {
    const about = await summary(admin, booking.id, guest.lang)
    if (!about) return
    await rememberRequest(admin, tapperId, booking.id)
    await say(message.chat.id, COPY[guest.lang].depositReceiptPicked(about.villa, about.dates), withoutReceiptKeyboard(guest.lang, booking.id))
    return
  }

  await submit(admin, message.chat.id, tapperId, guest, booking.id, null)
}
