import { copyText } from './clipboard'
import { bookingLink } from './holds'
import { currentLang, translate } from './strings'
import { canOpenTelegramLink, openTelegramLink } from './telegram'
import type { Villa } from './types'

/**
 * opened -- Telegram's chat picker is showing
 * copied -- no picker here, so the plain link was copied instead
 * failed -- neither worked; the caller must say so
 */
export type ShareResult = 'opened' | 'copied' | 'failed'

/**
 * Shares a villa's public booking link. Used by the owner's villa cards and
 * Villa Setup, so both behave the same.
 *
 * Inside Telegram this opens the native chat picker on t.me/share/url, with a
 * short line naming the villa that the owner can edit before sending.
 * Elsewhere, or if Telegram refuses, it copies the bare link instead. The
 * line carries no trailing colon because clients disagree on whether the
 * link goes above or below it.
 */
export async function shareBookingLink(villa: Pick<Villa, 'name' | 'villa_code'>): Promise<ShareResult> {
  const link = bookingLink(villa.villa_code)

  if (canOpenTelegramLink()) {
    const text = translate(currentLang(), 'share.bookingText', { villa: villa.name.trim() })
    try {
      if (openTelegramLink(`https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent(text)}`)) {
        return 'opened'
      }
    } catch {
      // The bridge throws on a link it will not open; copy instead.
    }
  }

  return (await copyText(link)) ? 'copied' : 'failed'
}
