// ============================================================================
// ManualPaynetProvider -- today's only PaymentProvider.
//
// The owner scans a static Paynet QR, pays 49,000 UZS, and sends the bot a
// screenshot of the receipt. The receipt goes to the private 'receipts'
// bucket, a pending subscription_payments row is created, and the admin gets
// the receipt with Confirm / Reject buttons. The admin's tap reaches markPaid
// or markRejected through telegram-bot-webhook, like any provider's would.
//
// Everything Paynet-specific is in this file: the QR, the wording of the
// instructions, and receipts. Swapping provider means constructing a
// different PaymentProvider in telegram-bot-webhook, nothing else.
// ============================================================================

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4'
import { botCall } from '../owner-bot.ts'
import type {
  IncomingReceipt,
  Lang,
  MarkPaidResult,
  MarkRejectedResult,
  PaymentInstructions,
  PaymentProvider,
  ReceiptResult,
} from './provider.ts'
import { SUBSCRIPTION_DAYS, SUBSCRIPTION_PRICE_UZS } from './provider.ts'
import {
  adminReviewMessage,
  closeReceiptWindow,
  formatUzs,
  loadPaymentContext,
  markSubscriptionPaid,
  rejectSubscriptionPayment,
} from './subscription.ts'

/** Receipts bigger than this are refused before downloading. */
const MAX_RECEIPT_BYTES = 10 * 1024 * 1024

const EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/heic': 'heic',
  'image/heif': 'heif',
}

const INSTRUCTIONS: Record<Lang, (amount: string, plainAmount: string, days: number) => string> = {
  en: (amount, plain, days) =>
    `Scan the QR code above in your banking app and pay exactly <b>${amount}</b>.\n\n` +
    `Amount to copy: <code>${plain}</code>\n\n` +
    `Then send the receipt screenshot here. Your ${days} days start when the payment is confirmed.`,
  ru: (amount, plain, days) =>
    `Отсканируйте QR-код выше в приложении банка и оплатите ровно <b>${amount}</b>.\n\n` +
    `Сумма для копирования: <code>${plain}</code>\n\n` +
    `Затем отправьте сюда скриншот чека. ${days} дней начнутся с момента подтверждения оплаты.`,
  uz: (amount, plain, days) =>
    `Yuqoridagi QR-kodni bank ilovangizda skanerlang va aynan <b>${amount}</b> to‘lang.\n\n` +
    `Nusxalash uchun summa: <code>${plain}</code>\n\n` +
    `So‘ng chek skrinshotini shu yerga yuboring. ${days} kun to‘lov tasdiqlangan paytdan boshlanadi.`,
}

export interface ManualPaynetConfig {
  admin: SupabaseClient
  /** Reads the QR image. The webhook passes its own bundled file. */
  loadQr: () => Promise<Uint8Array>
  /** Telegram id of the one person who confirms payments, or null if unset. */
  adminTelegramId: number | null
}

export class ManualPaynetProvider implements PaymentProvider {
  readonly id = 'manual_paynet'

  constructor(private readonly config: ManualPaynetConfig) {}

  async instructions(lang: Lang): Promise<PaymentInstructions> {
    const text = INSTRUCTIONS[lang](formatUzs(SUBSCRIPTION_PRICE_UZS), String(SUBSCRIPTION_PRICE_UZS), SUBSCRIPTION_DAYS)
    // A missing QR must not stop the amount and instructions going out; the
    // caller says the QR is unavailable and logs it.
    let bytes: Uint8Array
    try {
      bytes = await this.config.loadQr()
    } catch (err) {
      console.error(`[subscription] could not read the Paynet QR image: ${(err as Error).message}`)
      return { text }
    }
    return { photo: { bytes, filename: 'paynet-qr.png', contentType: 'image/png' }, text }
  }

  markPaid(userId: string, paymentId: string, confirmedBy: string): Promise<MarkPaidResult> {
    return markSubscriptionPaid(this.config.admin, userId, paymentId, confirmedBy)
  }

  markRejected(userId: string, paymentId: string, rejectedBy: string): Promise<MarkRejectedResult> {
    return rejectSubscriptionPayment(this.config.admin, userId, paymentId, rejectedBy)
  }

  /**
   * Stores the receipt privately, records a pending payment, and sends it to
   * the admin. The row is created first: its id names the file, and the
   * one-pending-per-user index turns a second screenshot into
   * 'already_pending' instead of a second review. If the file cannot be
   * stored, the row is removed again and the owner is asked to resend.
   */
  async acceptReceipt(userId: string, receipt: IncomingReceipt): Promise<ReceiptResult> {
    const { admin } = this.config
    if (!(receipt.contentType in EXTENSIONS)) return { outcome: 'unsupported' }
    if (receipt.sizeBytes !== null && receipt.sizeBytes > MAX_RECEIPT_BYTES) return { outcome: 'too_large' }

    const { data: row, error: insertError } = await admin
      .from('subscription_payments')
      .insert({ user_id: userId, provider: this.id, amount: SUBSCRIPTION_PRICE_UZS })
      .select('id')
      .single()
    if (insertError) {
      if (insertError.code === '23505') return { outcome: 'already_pending' }
      console.error(`[subscription] could not record a payment for user ${userId}: ${insertError.message}`)
      return { outcome: 'failed' }
    }
    const paymentId = row.id as string

    const stored = await this.storeReceipt(userId, paymentId, receipt)
    if (!stored) {
      await admin.from('subscription_payments').delete().eq('id', paymentId)
      return { outcome: 'failed' }
    }

    await closeReceiptWindow(admin, userId)
    await this.sendForReview(paymentId, receipt)
    return { outcome: 'received', paymentId }
  }

  /** Telegram -> private bucket, at '<user_id>/<payment_id>.<ext>'. */
  private async storeReceipt(userId: string, paymentId: string, receipt: IncomingReceipt): Promise<boolean> {
    const token = Deno.env.get('TELEGRAM_BOT_TOKEN') ?? ''
    const file = await botCall('getFile', { file_id: receipt.telegramFileId })
    if (!file.ok) {
      console.error(`[subscription] getFile failed for payment ${paymentId}: ${file.error}`)
      return false
    }
    const size = Number(file.result.file_size ?? 0)
    if (size > MAX_RECEIPT_BYTES) return false

    try {
      const response = await fetch(`https://api.telegram.org/file/bot${token}/${file.result.file_path}`, {
        signal: AbortSignal.timeout(15000),
      })
      if (!response.ok) throw new Error(`download ${response.status}`)
      const bytes = new Uint8Array(await response.arrayBuffer())

      const path = `${userId}/${paymentId}.${EXTENSIONS[receipt.contentType] ?? 'jpg'}`
      const { error } = await this.config.admin.storage
        .from('receipts')
        .upload(path, bytes, { contentType: receipt.contentType, upsert: false })
      if (error) throw new Error(error.message)

      await this.config.admin.from('subscription_payments').update({ receipt_file_path: path }).eq('id', paymentId)
      return true
    } catch (err) {
      console.error(`[subscription] could not store the receipt for payment ${paymentId}: ${(err as Error).message}`)
      return false
    }
  }

  /**
   * The admin's review: the receipt itself, re-sent by Telegram file id (no
   * public URL ever exists), with the payer's details and the two buttons.
   * Best-effort: a failure is logged as "[subscription-notify] FAILED" and the
   * payment stays pending, visible in /admin.
   */
  private async sendForReview(paymentId: string, receipt: IncomingReceipt): Promise<void> {
    const adminId = this.config.adminTelegramId
    if (!adminId) {
      console.error(`[subscription-notify] FAILED: ADMIN_TELEGRAM_ID is not set; payment ${paymentId} is waiting unseen`)
      return
    }
    const ctx = await loadPaymentContext(this.config.admin, paymentId)
    if (!ctx) return
    const message = adminReviewMessage(ctx)
    const sent = await botCall(receipt.kind === 'photo' ? 'sendPhoto' : 'sendDocument', {
      chat_id: adminId,
      [receipt.kind]: receipt.telegramFileId,
      caption: message.caption,
      parse_mode: 'HTML',
      reply_markup: message.reply_markup,
    })
    if (!sent.ok) console.error(`[subscription-notify] FAILED to send payment ${paymentId} to the admin: ${sent.error}`)
  }
}
