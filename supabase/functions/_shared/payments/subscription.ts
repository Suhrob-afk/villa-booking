// ============================================================================
// Subscription logic that does not depend on how an owner pays: granting and
// closing payments, the receipt window, and the admin's review message.
//
// Every write goes through a service-role SQL function from migration 0024.
// markSubscriptionPaid() is the only caller of mark_subscription_paid(), and
// that is the only place time is granted.
// ============================================================================

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4'
import { escapeHtml, formatUzs, MONTHS_SHORT } from '../owner-bot.ts'
import type { Lang, MarkPaidResult, MarkRejectedResult, PaymentStatus } from './provider.ts'

// ------------------------------------------------------- granting time ----

export async function markSubscriptionPaid(
  admin: SupabaseClient,
  userId: string,
  paymentId: string,
  confirmedBy: string,
): Promise<MarkPaidResult> {
  const { data, error } = await admin.rpc('mark_subscription_paid', {
    p_payment_id: paymentId,
    p_user_id: userId,
    p_confirmed_by: confirmedBy,
  })
  if (error) throw new Error(error.message)
  const r = data as { outcome: string; status?: PaymentStatus; paid_until?: string | null }
  if (r.outcome === 'confirmed') return { outcome: 'confirmed', paidUntil: r.paid_until as string }
  if (r.outcome === 'already_handled') {
    return { outcome: 'already_handled', status: r.status as PaymentStatus, paidUntil: r.paid_until ?? null }
  }
  return { outcome: 'not_found' }
}

export async function rejectSubscriptionPayment(
  admin: SupabaseClient,
  userId: string,
  paymentId: string,
  rejectedBy: string,
): Promise<MarkRejectedResult> {
  const { data, error } = await admin.rpc('reject_subscription_payment', {
    p_payment_id: paymentId,
    p_user_id: userId,
    p_rejected_by: rejectedBy,
  })
  if (error) throw new Error(error.message)
  const r = data as { outcome: string; status?: PaymentStatus; paid_until?: string | null }
  if (r.outcome === 'rejected') return { outcome: 'rejected' }
  if (r.outcome === 'already_handled') {
    return { outcome: 'already_handled', status: r.status as PaymentStatus, paidUntil: r.paid_until ?? null }
  }
  return { outcome: 'not_found' }
}

/** Active, including the 3-day grace -- the same answer the database's guards use. */
export async function hasActiveSubscription(admin: SupabaseClient, userId: string): Promise<boolean> {
  const { data, error } = await admin.rpc('has_active_subscription', { p_user_id: userId })
  if (error) throw new Error(error.message)
  return data === true
}

export async function paidUntil(admin: SupabaseClient, userId: string): Promise<string | null> {
  const { data } = await admin.from('subscriptions').select('paid_until').eq('user_id', userId).maybeSingle()
  return (data?.paid_until as string | null | undefined) ?? null
}

// ----------------------------------------------------- receipt window ----
// After /subscribe the bot takes the owner's next photo as a receipt, for a
// day. Outside that window a photo is just a photo and reaches nobody.

const RECEIPT_WINDOW_MS = 24 * 60 * 60 * 1000

export async function openReceiptWindow(admin: SupabaseClient, userId: string): Promise<void> {
  const { error } = await admin
    .from('subscriptions')
    .upsert({ user_id: userId, receipt_requested_at: new Date().toISOString() }, { onConflict: 'user_id' })
  if (error) throw new Error(error.message)
}

export async function closeReceiptWindow(admin: SupabaseClient, userId: string): Promise<void> {
  await admin.from('subscriptions').update({ receipt_requested_at: null }).eq('user_id', userId)
}

export async function receiptWindowOpen(admin: SupabaseClient, userId: string): Promise<boolean> {
  const { data } = await admin
    .from('subscriptions')
    .select('receipt_requested_at')
    .eq('user_id', userId)
    .maybeSingle()
  const at = data?.receipt_requested_at as string | null | undefined
  return Boolean(at && Date.now() - Date.parse(at) < RECEIPT_WINDOW_MS)
}

// ------------------------------------------------------------ payments ----

export interface PaymentContext {
  payment: {
    id: string
    user_id: string
    provider: string
    amount: number
    status: PaymentStatus
    created_at: string
    confirmed_at: string | null
    rejected_at: string | null
  }
  user: { name: string; phone: string | null; oikozId: string; telegramId: number; lang: Lang }
  paidUntil: string | null
}

const asLang = (value: unknown): Lang => (value === 'ru' || value === 'uz' ? value : 'en')

export async function loadPaymentContext(admin: SupabaseClient, paymentId: string): Promise<PaymentContext | null> {
  const { data: payment, error } = await admin
    .from('subscription_payments')
    .select('id, user_id, provider, amount, status, created_at, confirmed_at, rejected_at')
    .eq('id', paymentId)
    .maybeSingle()
  if (error) throw new Error(error.message)
  if (!payment) return null

  const [{ data: user, error: userError }, until] = await Promise.all([
    admin.from('users').select('name, full_name, phone, oikoz_id, telegram_id, language').eq('id', payment.user_id).single(),
    paidUntil(admin, payment.user_id as string),
  ])
  if (userError) throw new Error(userError.message)

  return {
    payment: { ...payment, amount: Number(payment.amount) } as PaymentContext['payment'],
    user: {
      name: ((user.full_name as string | null)?.trim() || (user.name as string | null)?.trim() || '—') as string,
      phone: (user.phone as string | null) ?? null,
      oikozId: user.oikoz_id as string,
      telegramId: Number(user.telegram_id),
      lang: asLang(user.language),
    },
    paidUntil: until,
  }
}

// ---------------------------------------------------------- formatting ----

/** The calendar date in Tashkent, as "12 Nov" (or "12 нояб"...). */
export function dayMonth(iso: string, lang: Lang): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tashkent',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(iso))
  const day = Number(parts.find((p) => p.type === 'day')?.value)
  const month = Number(parts.find((p) => p.type === 'month')?.value)
  return `${day} ${MONTHS_SHORT[lang][month - 1]}`
}

/** "12 Oct 2026, 14:05" in Tashkent, for the admin. */
function tashkentStamp(iso: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Tashkent',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(iso))
}

export { formatUzs }

// -------------------------------------------------- the admin's message ----
// English only, like /admin. Rebuilt from the database on every edit, so a
// double tap or a stale tap shows the payment as it now stands.
//
// Callback data: "sp:<c|r>:<payment uuid>", 41 bytes, under Telegram's 64.

const CALLBACK_RE = /^sp:(c|r):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/

export function parseSubscriptionCallback(data: string): { action: 'c' | 'r'; paymentId: string } | null {
  const match = CALLBACK_RE.exec(data)
  return match ? { action: match[1] as 'c' | 'r', paymentId: match[2] } : null
}

export function adminReviewMessage(ctx: PaymentContext): { caption: string; reply_markup: Record<string, unknown> } {
  const p = ctx.payment
  const lines = [
    '💳 <b>Subscription payment</b>',
    '',
    `👤 ${escapeHtml(ctx.user.name)}`,
    `📞 ${escapeHtml(ctx.user.phone ?? '—')}`,
    `🆔 ${escapeHtml(ctx.user.oikozId)}`,
    `💰 ${formatUzs(p.amount)}`,
    `🕒 ${tashkentStamp(p.created_at)} (Tashkent)`,
  ]

  if (p.status === 'pending') {
    lines.push('', 'Check the receipt against your Paynet account before confirming.')
    return {
      caption: lines.join('\n'),
      reply_markup: {
        inline_keyboard: [[
          { text: '✅ Confirm payment', callback_data: `sp:c:${p.id}` },
          { text: '❌ Reject', callback_data: `sp:r:${p.id}` },
        ]],
      },
    }
  }

  lines.push(
    '',
    p.status === 'confirmed'
      ? `✅ <b>Confirmed</b>${ctx.paidUntil ? ` — active until ${dayMonth(ctx.paidUntil, 'en')}` : ''}`
      : '❌ <b>Rejected</b> — the owner was asked to check the amount and resend.',
  )
  return { caption: lines.join('\n'), reply_markup: { inline_keyboard: [] } }
}

// ------------------------------------------------------- bot uploads ----

/** multipart/form-data call for sending a file. Never throws. */
export async function botUpload(
  method: string,
  form: FormData,
): Promise<{ ok: true; result: Record<string, unknown> } | { ok: false; error: string }> {
  const token = Deno.env.get('TELEGRAM_BOT_TOKEN') ?? ''
  if (!token) return { ok: false, error: 'TELEGRAM_BOT_TOKEN is not set' }
  try {
    const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(15000),
    })
    const body = (await response.json().catch(() => ({}))) as {
      ok?: boolean
      result?: Record<string, unknown>
      description?: string
    }
    if (!response.ok || !body.ok) return { ok: false, error: `${response.status} ${body.description ?? 'no description'}` }
    return { ok: true, result: body.result ?? {} }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}
