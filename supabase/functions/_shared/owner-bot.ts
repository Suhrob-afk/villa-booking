// ============================================================================
// The bot's side of a public booking: telling the villa owner about a hold,
// asking them to confirm the deposit, and telling the guest how it ended.
//
// Used by create-public-booking (the heads-up), mark-deposit-sent (the message
// with the Confirm received / Reject buttons) and telegram-bot-webhook (the
// taps on those buttons). Every message is rebuilt from the database, never
// from an earlier message's text, so an edit always shows the booking as it
// now stands.
//
// Sending is best-effort everywhere: a failure is logged and swallowed. The
// owner may have blocked the bot, and a guest registered from the booking
// page may never have started it at all.
//
// Supabase bundles relative imports into each function at deploy time, so
// every function importing this file must be redeployed when it changes.
// ============================================================================

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4'

export type Lang = 'en' | 'ru' | 'uz'

const asLang = (value: unknown): Lang => (value === 'ru' || value === 'uz' ? value : 'en')

// --------------------------------------------------------------- Telegram ----

type Json = Record<string, unknown>

export type BotResult = { ok: true; result: Json } | { ok: false; error: string }

/** Never throws. `error` is Telegram's own description, e.g. "Forbidden: bot was blocked by the user". */
export async function botCall(method: string, payload: Json): Promise<BotResult> {
  const token = Deno.env.get('TELEGRAM_BOT_TOKEN') ?? ''
  if (!token) return { ok: false, error: 'TELEGRAM_BOT_TOKEN is not set' }
  try {
    const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(8000),
    })
    const body = (await response.json().catch(() => ({}))) as { ok?: boolean; result?: Json; description?: string }
    if (!response.ok || !body.ok) return { ok: false, error: `${response.status} ${body.description ?? 'no description'}` }
    return { ok: true, result: body.result ?? {} }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}

// ---------------------------------------------------------- callback data ----
// "bk:<action>:<booking uuid>" -- at most 42 bytes, under Telegram's 64.
//
//   c   Confirm received
//   rc  Confirm anyway (after being told the hold expired)
//   r   Reject

export type BookingAction = 'c' | 'rc' | 'r'

const CALLBACK_RE = /^bk:(c|rc|r):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/

export function parseBookingCallback(data: string): { action: BookingAction; bookingId: string } | null {
  const match = CALLBACK_RE.exec(data)
  return match ? { action: match[1] as BookingAction, bookingId: match[2] } : null
}

const callbackData = (action: BookingAction, bookingId: string) => `bk:${action}:${bookingId}`

// ---------------------------------------------------------------- context ----

export interface BookingContext {
  booking: {
    id: string
    villa_id: string
    status: 'confirmed' | 'cancelled' | 'pending' | 'expired' | 'rejected'
    check_in: string
    check_out: string
    client_name: string
    client_phone: string | null
    deposit_amount: number
    hold_expires_at: string | null
    client_user_id: string | null
  }
  villaName: string
  owner: { id: string; telegramId: number; lang: Lang }
  /** The visitor who made the hold. */
  guest: { telegramId: number; lang: Lang } | null
}

/** Everything a message about this booking needs, or null if it is gone. */
export async function loadBookingContext(admin: SupabaseClient, bookingId: string): Promise<BookingContext | null> {
  const { data: booking, error } = await admin
    .from('bookings')
    .select('id, villa_id, status, check_in, check_out, client_name, client_phone, deposit_amount, hold_expires_at, client_user_id')
    .eq('id', bookingId)
    .maybeSingle()
  if (error) throw new Error(error.message)
  if (!booking) return null

  const { data: villa, error: villaError } = await admin
    .from('villas')
    .select('name, owner_id')
    .eq('id', booking.villa_id)
    .single()
  if (villaError) throw new Error(villaError.message)

  const [owner, guest] = await Promise.all([
    admin.from('users').select('id, telegram_id, language').eq('id', villa.owner_id).single(),
    booking.client_user_id
      ? admin.from('users').select('telegram_id, language').eq('id', booking.client_user_id).maybeSingle()
      : Promise.resolve({ data: null, error: null }),
  ])
  if (owner.error) throw new Error(owner.error.message)

  return {
    booking: { ...booking, deposit_amount: Number(booking.deposit_amount) } as BookingContext['booking'],
    villaName: villa.name as string,
    owner: { id: owner.data.id as string, telegramId: Number(owner.data.telegram_id), lang: asLang(owner.data.language) },
    guest: guest.data ? { telegramId: Number(guest.data.telegram_id), lang: asLang(guest.data.language) } : null,
  }
}

// ------------------------------------------------------------- formatting ----

const MONTHS_SHORT: Record<Lang, string[]> = {
  en: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
  ru: ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'],
  uz: ['yan', 'fev', 'mar', 'apr', 'may', 'iyn', 'iyl', 'avg', 'sen', 'okt', 'noy', 'dek'],
}

/** Names and phones come from Telegram profiles and are sent with parse_mode HTML. */
export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** "2026-10-12" -> "12 Oct 2026". Pure string work: no Date, so no time zone. */
function formatDay(iso: string, lang: Lang): string {
  const [y, m, d] = iso.split('-').map(Number)
  return `${d} ${MONTHS_SHORT[lang][m - 1]} ${y}`
}

function nightCount(checkIn: string, checkOut: string): number {
  return Math.round((Date.parse(`${checkOut}T00:00:00Z`) - Date.parse(`${checkIn}T00:00:00Z`)) / 86_400_000)
}

function nightsLabel(n: number, lang: Lang): string {
  if (lang === 'en') return `${n} ${n === 1 ? 'night' : 'nights'}`
  if (lang === 'uz') return `${n} kecha`
  const mod10 = n % 10
  const mod100 = n % 100
  const word = mod10 === 1 && mod100 !== 11 ? 'ночь' : mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14) ? 'ночи' : 'ночей'
  return `${n} ${word}`
}

function stay(b: BookingContext['booking'], lang: Lang): string {
  return `${formatDay(b.check_in, lang)} → ${formatDay(b.check_out, lang)} (${nightsLabel(nightCount(b.check_in, b.check_out), lang)})`
}

/** Deposits are always UZS. Same Intl formatting as the app's formatMoney(). */
function formatUzs(amount: number): string {
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'UZS', maximumFractionDigits: 0 }).format(amount)
  } catch {
    return `${Math.round(amount)} UZS`
  }
}

/** Wall-clock time in Tashkent, where every villa is. */
function tashkentTime(iso: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Tashkent',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(iso))
}

// ------------------------------------------------------------------- copy ----

/** How the owner's deposit message ends, once there is something to say. */
export type Footer =
  | 'confirmed'
  | 'rejected'
  | 'cancelled'
  | 'expired_free'
  | 'expired_taken'
  | 'expired_closed'

interface OwnerCopy {
  headsUpTitle: string
  headsUpBody: string
  depositTitle: string
  deposit: string
  depositAsk: (until: string) => string
  confirmButton: string
  confirmAnywayButton: string
  rejectButton: string
  footer: Record<Footer, string>
  toastConfirmed: string
  toastRejected: string
  toastAlreadyHandled: string
  toastExpired: string
  toastFailed: string
}

export const OWNER_COPY: Record<Lang, OwnerCopy> = {
  en: {
    headsUpTitle: '🕓 <b>New hold on your villa</b>',
    headsUpBody:
      'A guest from your booking link is holding these dates. They have 30 minutes to transfer the deposit to your card. When they say they’ve sent it, I’ll ask you to confirm.',
    depositTitle: '💰 <b>Deposit sent — please check your card</b>',
    deposit: 'Deposit',
    depositAsk: (until) =>
      `The guest says they’ve transferred the deposit. Once it has arrived, tap “Confirm received”. The dates are held until ${until} (Tashkent time).`,
    confirmButton: '✅ Confirm received',
    confirmAnywayButton: '✅ Confirm anyway',
    rejectButton: '❌ Reject',
    footer: {
      confirmed: '✅ <b>Confirmed</b> — deposit received. The booking is in your calendar.',
      rejected: '❌ <b>Rejected</b> — the dates are free again.',
      cancelled: 'This booking has since been cancelled in the app.',
      expired_free:
        '⏰ <b>This hold has expired</b>, but the dates are still free. If the deposit did arrive, you can still confirm the booking.',
      expired_taken:
        '⏰ <b>This hold has expired</b> and the dates are no longer free. If the guest did send the deposit, please refund it — their number is above.',
      expired_closed:
        '⏰ <b>This hold has expired</b> and can no longer be confirmed. If the guest did send the deposit, please refund it — their number is above.',
    },
    toastConfirmed: 'Confirmed',
    toastRejected: 'Rejected',
    toastAlreadyHandled: 'Already handled',
    toastExpired: 'This hold has expired',
    toastFailed: 'Something went wrong. Please try again.',
  },

  ru: {
    headsUpTitle: '🕓 <b>Новое удержание на вашей вилле</b>',
    headsUpBody:
      'Гость по вашей ссылке удерживает эти даты. У него есть 30 минут, чтобы перевести депозит на вашу карту. Когда он сообщит, что отправил его, я попрошу вас подтвердить.',
    depositTitle: '💰 <b>Депозит отправлен — проверьте карту</b>',
    deposit: 'Депозит',
    depositAsk: (until) =>
      `Гость сообщает, что перевёл депозит. Когда деньги поступят, нажмите «Получено». Даты удерживаются до ${until} (по Ташкенту).`,
    confirmButton: '✅ Получено',
    confirmAnywayButton: '✅ Всё равно подтвердить',
    rejectButton: '❌ Отклонить',
    footer: {
      confirmed: '✅ <b>Подтверждено</b> — депозит получен. Бронь уже в вашем календаре.',
      rejected: '❌ <b>Отклонено</b> — даты снова свободны.',
      cancelled: 'С тех пор эта бронь отменена в приложении.',
      expired_free:
        '⏰ <b>Срок удержания истёк</b>, но даты всё ещё свободны. Если депозит всё же пришёл, бронь можно подтвердить.',
      expired_taken:
        '⏰ <b>Срок удержания истёк</b>, и даты уже заняты. Если гость всё же отправил депозит, верните его — номер гостя указан выше.',
      expired_closed:
        '⏰ <b>Срок удержания истёк</b>, подтвердить бронь уже нельзя. Если гость всё же отправил депозит, верните его — номер гостя указан выше.',
    },
    toastConfirmed: 'Подтверждено',
    toastRejected: 'Отклонено',
    toastAlreadyHandled: 'Уже обработано',
    toastExpired: 'Срок удержания истёк',
    toastFailed: 'Что-то пошло не так. Попробуйте ещё раз.',
  },

  uz: {
    headsUpTitle: '🕓 <b>Villangizda yangi band qilish</b>',
    headsUpBody:
      'Havolangiz orqali kelgan mehmon bu sanalarni band qilib turibdi. Depozitni kartangizga o‘tkazish uchun unda 30 daqiqa bor. U yuborganini aytganida, sizdan tasdiqlashni so‘rayman.',
    depositTitle: '💰 <b>Depozit yuborildi — kartangizni tekshiring</b>',
    deposit: 'Depozit',
    depositAsk: (until) =>
      `Mehmon depozitni o‘tkazganini aytmoqda. Pul kelib tushgach, «Qabul qildim» tugmasini bosing. Sanalar soat ${until} gacha (Toshkent vaqti) band turadi.`,
    confirmButton: '✅ Qabul qildim',
    confirmAnywayButton: '✅ Baribir tasdiqlash',
    rejectButton: '❌ Rad etish',
    footer: {
      confirmed: '✅ <b>Tasdiqlandi</b> — depozit qabul qilindi. Bron kalendaringizda.',
      rejected: '❌ <b>Rad etildi</b> — sanalar yana bo‘sh.',
      cancelled: 'Keyinroq bu bron ilovada bekor qilingan.',
      expired_free:
        '⏰ <b>Band qilish muddati tugadi</b>, lekin sanalar hali bo‘sh. Agar depozit kelgan bo‘lsa, bronni baribir tasdiqlashingiz mumkin.',
      expired_taken:
        '⏰ <b>Band qilish muddati tugadi</b> va sanalar endi bo‘sh emas. Agar mehmon depozitni yuborgan bo‘lsa, uni qaytaring — raqami yuqorida.',
      expired_closed:
        '⏰ <b>Band qilish muddati tugadi</b>, bronni endi tasdiqlab bo‘lmaydi. Agar mehmon depozitni yuborgan bo‘lsa, uni qaytaring — raqami yuqorida.',
    },
    toastConfirmed: 'Tasdiqlandi',
    toastRejected: 'Rad etildi',
    toastAlreadyHandled: 'Allaqachon ko‘rib chiqilgan',
    toastExpired: 'Band qilish muddati tugagan',
    toastFailed: 'Nimadir xato ketdi. Qaytadan urinib ko‘ring.',
  },
}

interface GuestCopy {
  confirmed: (villa: string, stay: string) => string
  rejected: (villa: string, stay: string) => string
}

const GUEST_COPY: Record<Lang, GuestCopy> = {
  en: {
    confirmed: (villa, s) =>
      `✅ <b>Your booking is confirmed</b>\n\n🏡 ${villa}\n📅 ${s}\n\nThe owner has received your deposit. See you there!`,
    rejected: (villa, s) =>
      `Your reservation wasn’t confirmed.\n\n🏡 ${villa}\n📅 ${s}\n\nThe owner couldn’t confirm your deposit, and the dates were released. If you already transferred it, the owner can reach you on the number you shared.`,
  },
  ru: {
    confirmed: (villa, s) =>
      `✅ <b>Ваша бронь подтверждена</b>\n\n🏡 ${villa}\n📅 ${s}\n\nВладелец получил ваш депозит. Ждём вас!`,
    rejected: (villa, s) =>
      `Ваша бронь не подтверждена.\n\n🏡 ${villa}\n📅 ${s}\n\nВладелец не смог подтвердить ваш депозит, даты освобождены. Если вы уже перевели его, владелец может связаться с вами по номеру, которым вы поделились.`,
  },
  uz: {
    confirmed: (villa, s) =>
      `✅ <b>Broningiz tasdiqlandi</b>\n\n🏡 ${villa}\n📅 ${s}\n\nEgasi depozitingizni oldi. Sizni kutamiz!`,
    rejected: (villa, s) =>
      `Broningiz tasdiqlanmadi.\n\n🏡 ${villa}\n📅 ${s}\n\nEgasi depozitingizni tasdiqlay olmadi, sanalar bo‘shatildi. Agar uni allaqachon o‘tkazgan bo‘lsangiz, egasi siz ulashgan raqam orqali siz bilan bog‘lana oladi.`,
  },
}

// --------------------------------------------------------------- messages ----

function details(ctx: BookingContext, lang: Lang, withPhone: boolean): string {
  const b = ctx.booking
  const copy = OWNER_COPY[lang]
  return [
    `🏡 ${escapeHtml(ctx.villaName)}`,
    `👤 ${escapeHtml(b.client_name)}`,
    ...(withPhone && b.client_phone ? [`📞 ${escapeHtml(b.client_phone)}`] : []),
    `📅 ${stay(b, lang)}`,
    `💳 ${copy.deposit}: ${formatUzs(b.deposit_amount)}`,
  ].join('\n')
}

export function headsUpText(ctx: BookingContext): string {
  const copy = OWNER_COPY[ctx.owner.lang]
  return `${copy.headsUpTitle}\n\n${details(ctx, ctx.owner.lang, false)}\n\n${copy.headsUpBody}`
}

/**
 * The owner's deposit message. Without a footer it is the question, with the
 * Confirm received / Reject buttons; with one it is the answer, and only
 * 'expired_free' keeps buttons ("Confirm anyway" / Reject).
 */
export function depositMessage(ctx: BookingContext, footer: Footer | null): { text: string; reply_markup: Json } {
  const lang = ctx.owner.lang
  const copy = OWNER_COPY[lang]
  const b = ctx.booking
  const head = `${copy.depositTitle}\n\n${details(ctx, lang, true)}`

  if (footer === null) {
    const until = b.hold_expires_at ? tashkentTime(b.hold_expires_at) : '—'
    return {
      text: `${head}\n\n${copy.depositAsk(until)}`,
      reply_markup: {
        inline_keyboard: [[
          { text: copy.confirmButton, callback_data: callbackData('c', b.id) },
          { text: copy.rejectButton, callback_data: callbackData('r', b.id) },
        ]],
      },
    }
  }

  // One button per row: "Всё равно подтвердить" is too long for half a row.
  const keyboard =
    footer === 'expired_free'
      ? [
          [{ text: copy.confirmAnywayButton, callback_data: callbackData('rc', b.id) }],
          [{ text: copy.rejectButton, callback_data: callbackData('r', b.id) }],
        ]
      : []
  return { text: `${head}\n\n${copy.footer[footer]}`, reply_markup: { inline_keyboard: keyboard } }
}

// ------------------------------------------------------------ owner sends ----

export type OwnerMessageKind = 'hold_created' | 'deposit_sent'

/**
 * Sends the owner the heads-up or the deposit message for a booking, at most
 * once per (booking, kind): the booking_owner_messages row is claimed before
 * sending, so a double tap or a retried request is a no-op.
 *
 * Never throws -- the visitor's request must succeed whether or not the owner
 * can be reached. A failure is logged with "[owner-notify] FAILED" so it can
 * be searched for in the function logs, and stays in booking_owner_messages
 * with sent_at null and Telegram's error.
 */
export async function notifyOwner(admin: SupabaseClient, bookingId: string, kind: OwnerMessageKind): Promise<void> {
  try {
    const { error: claimError } = await admin.from('booking_owner_messages').insert({ booking_id: bookingId, kind })
    if (claimError) {
      if (claimError.code === '23505') return // already sent, or being sent right now
      console.error(`[owner-notify] FAILED to claim ${kind} for booking ${bookingId}: ${claimError.message}`)
      return
    }

    const ctx = await loadBookingContext(admin, bookingId)
    if (!ctx) return

    const message =
      kind === 'hold_created'
        ? { text: headsUpText(ctx), reply_markup: undefined }
        : depositMessage(ctx, null)

    const sent = await botCall('sendMessage', {
      chat_id: ctx.owner.telegramId,
      text: message.text,
      parse_mode: 'HTML',
      ...(message.reply_markup ? { reply_markup: message.reply_markup } : {}),
    })

    if (sent.ok) {
      await admin
        .from('booking_owner_messages')
        .update({
          chat_id: ctx.owner.telegramId,
          message_id: Number(sent.result.message_id),
          sent_at: new Date().toISOString(),
        })
        .eq('booking_id', bookingId)
        .eq('kind', kind)
      return
    }

    console.error(
      `[owner-notify] FAILED to send ${kind} for booking ${bookingId} to owner ${ctx.owner.id} ` +
        `(telegram ${ctx.owner.telegramId}): ${sent.error}`,
    )
    await admin
      .from('booking_owner_messages')
      .update({ chat_id: ctx.owner.telegramId, error: sent.error })
      .eq('booking_id', bookingId)
      .eq('kind', kind)
  } catch (err) {
    console.error(`[owner-notify] FAILED ${kind} for booking ${bookingId}: ${(err as Error).message}`)
  }
}

// ------------------------------------------------------------ guest sends ----

/**
 * Tells the visitor how their hold ended. Best-effort and quiet: a visitor
 * who only ever opened the booking page has never started the bot, and
 * Telegram refuses to message them -- they still see the result on the page.
 */
export async function notifyGuest(ctx: BookingContext, outcome: 'confirmed' | 'rejected'): Promise<void> {
  if (!ctx.guest) return
  const lang = ctx.guest.lang
  const text = GUEST_COPY[lang][outcome](escapeHtml(ctx.villaName), stay(ctx.booking, lang))
  const sent = await botCall('sendMessage', { chat_id: ctx.guest.telegramId, text, parse_mode: 'HTML' })
  if (!sent.ok) console.log(`[guest-notify] could not message the guest of booking ${ctx.booking.id}: ${sent.error}`)
}
