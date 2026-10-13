// ============================================================================
// Receipt screenshots: Telegram -> the private 'receipts' bucket.
//
// Shared by subscription receipts (payments/manual-paynet.ts, stored under
// '<user_id>/...') and guests' deposit receipts (telegram-bot-webhook,
// stored under 'deposits/<booking_id>/...'). The bucket is private (0024):
// nothing here produces a URL, and the only read policy lets a user read the
// folder named after their own id, which 'deposits' never is. Whoever needs to
// see a receipt gets it from Telegram by file id.
//
// Supabase bundles relative imports into each function at deploy time, so
// every function importing this file must be redeployed when it changes.
// ============================================================================

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4'
import { botCall } from './owner-bot.ts'

/** Receipts bigger than this are refused before downloading. The bucket enforces it too. */
export const MAX_RECEIPT_BYTES = 10 * 1024 * 1024

/** The image types the bucket accepts (0024), and the extension each is stored with. */
const EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/heic': 'heic',
  'image/heif': 'heif',
}

/** The file extension for an accepted image type, or null if it is not one. */
export function receiptExtension(contentType: string): string | null {
  return EXTENSIONS[contentType] ?? null
}

/**
 * Downloads a Telegram file and stores it at `path` in the receipts bucket.
 * Never overwrites. Returns false (and logs under `logTag`) on any failure,
 * including a file that turns out to be over MAX_RECEIPT_BYTES.
 */
export async function storeTelegramImage(
  admin: SupabaseClient,
  telegramFileId: string,
  path: string,
  contentType: string,
  logTag: string,
): Promise<boolean> {
  const token = Deno.env.get('TELEGRAM_BOT_TOKEN') ?? ''
  const file = await botCall('getFile', { file_id: telegramFileId })
  if (!file.ok) {
    console.error(`[${logTag}] getFile failed for ${path}: ${file.error}`)
    return false
  }
  if (Number(file.result.file_size ?? 0) > MAX_RECEIPT_BYTES) return false

  try {
    const response = await fetch(`https://api.telegram.org/file/bot${token}/${file.result.file_path}`, {
      signal: AbortSignal.timeout(15000),
    })
    if (!response.ok) throw new Error(`download ${response.status}`)
    const bytes = new Uint8Array(await response.arrayBuffer())
    const { error } = await admin.storage.from('receipts').upload(path, bytes, { contentType, upsert: false })
    if (error) throw new Error(error.message)
    return true
  } catch (err) {
    console.error(`[${logTag}] could not store ${path}: ${(err as Error).message}`)
    return false
  }
}
