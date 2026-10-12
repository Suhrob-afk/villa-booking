// ============================================================================
// PaymentProvider -- the only thing the bot and the subscription logic know
// about how an owner pays. Today there is one: ManualPaynetProvider (a static
// Paynet QR, a receipt screenshot, and the admin confirming in Telegram).
//
// WHAT A NEW PROVIDER (Payme, Click, ...) MUST IMPLEMENT
//
//   id            A short, stable name. It is stored on every
//                 subscription_payments row the provider creates.
//   instructions  What an owner sees after /subscribe: HTML text, and an
//                 optional photo sent before it. A gateway would return a
//                 pay link here instead of a QR.
//   markPaid      Grant the time for one payment. Implement it by calling
//                 markSubscriptionPaid() from ./subscription.ts, which calls
//                 the database's mark_subscription_paid(): the ONE place time
//                 is ever granted. It is idempotent -- a repeated call for the
//                 same payment grants nothing and says 'already_handled'.
//   markRejected  Close one payment without granting time
//                 (rejectSubscriptionPayment() in ./subscription.ts).
//
//   acceptReceipt Optional. Only providers that are confirmed by a person
//                 looking at a screenshot need it; a gateway leaves it out.
//
// A gateway's own webhook (a new Edge Function) creates a pending
// subscription_payments row with its id, and calls markPaid(userId,
// paymentId, '<provider id>') once the gateway reports the money arrived.
// telegram-bot-webhook does not change: it picks the active provider in one
// line and only ever calls these methods.
// ============================================================================

export type Lang = 'en' | 'ru' | 'uz'

/** 49,000 UZS for 30 days. The database grants exactly 30 days per payment. */
export const SUBSCRIPTION_PRICE_UZS = 49_000
export const SUBSCRIPTION_DAYS = 30

export type PaymentStatus = 'pending' | 'confirmed' | 'rejected'

export interface PaymentInstructions {
  /** Sent first, if present: e.g. the QR code to scan. */
  photo?: { bytes: Uint8Array; filename: string; contentType: string }
  /** HTML (parse_mode HTML), sent after the photo. */
  text: string
}

export type MarkPaidResult =
  | { outcome: 'confirmed'; paidUntil: string }
  | { outcome: 'already_handled'; status: PaymentStatus; paidUntil: string | null }
  | { outcome: 'not_found' }

export type MarkRejectedResult =
  | { outcome: 'rejected' }
  | { outcome: 'already_handled'; status: PaymentStatus; paidUntil: string | null }
  | { outcome: 'not_found' }

/** A receipt the owner sent the bot: a photo, or an image sent as a file. */
export interface IncomingReceipt {
  telegramFileId: string
  kind: 'photo' | 'document'
  contentType: string
  sizeBytes: number | null
}

export type ReceiptResult =
  | { outcome: 'received'; paymentId: string }
  | { outcome: 'already_pending' }
  /** Not a kind of file this provider takes as a receipt. */
  | { outcome: 'unsupported' }
  | { outcome: 'too_large' }
  | { outcome: 'failed' }

export interface PaymentProvider {
  readonly id: string
  instructions(lang: Lang): Promise<PaymentInstructions>
  markPaid(userId: string, paymentId: string, confirmedBy: string): Promise<MarkPaidResult>
  markRejected(userId: string, paymentId: string, rejectedBy: string): Promise<MarkRejectedResult>
  acceptReceipt?(userId: string, receipt: IncomingReceipt): Promise<ReceiptResult>
}
