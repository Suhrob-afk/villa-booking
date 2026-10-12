import { formatMoney } from '../lib/format'
import { useI18n } from '../lib/i18n'
import {
  formatDayMonth,
  graceEndsAt,
  openSubscribe,
  SUBSCRIPTION_DAYS,
  SUBSCRIPTION_PRICE_UZS,
  useMySubscription,
  type VillaAccess,
} from '../lib/subscription'

function SubscribeButton() {
  const { t } = useI18n()
  return (
    <button type="button" className="button subscription-button" onClick={openSubscribe}>
      {t('sub.subscribe', { price: formatMoney(SUBSCRIPTION_PRICE_UZS, 'UZS'), days: SUBSCRIPTION_DAYS })}
    </button>
  )
}

/**
 * Top of Home for someone who owns villas and is not on an active
 * subscription: in grace, lapsed, or never paid. Nothing at all when active,
 * and nothing for a makler with no villas of their own -- the caller decides
 * that by only rendering it for villa owners.
 */
export function SubscriptionBanner() {
  const { lang, t } = useI18n()
  const { state, paidUntil } = useMySubscription()
  if (state === null || state === 'active') return null

  const lapsed = state === 'lapsed'
  const title =
    state === 'never' ? t('sub.bannerNeverTitle') : lapsed ? t('sub.bannerLapsedTitle') : t('sub.bannerGraceTitle')
  const body =
    state === 'never' || !paidUntil
      ? t('sub.bannerNeverBody')
      : lapsed
        ? t('sub.bannerLapsedBody', { date: formatDayMonth(paidUntil, lang) })
        : t('sub.bannerGraceBody', { date: formatDayMonth(graceEndsAt(paidUntil), lang) })

  return (
    <div className={`subscription-banner${lapsed ? ' is-lapsed' : ''}`} role="status">
      <strong>{title}</strong>
      <p>{body}</p>
      <SubscribeButton />
    </div>
  )
}

/**
 * Why the controls on a villa screen are disabled. Its own owner gets a way to
 * renew; anyone else (a makler) is only told -- they are never charged.
 * 'create' is for a new villa, which the person creating it pays for.
 */
export function ReadOnlyNotice({
  access,
  withButton = true,
}: {
  access: Exclude<VillaAccess, 'open'> | 'create'
  /** False when a SubscriptionBanner with its own button is already on screen. */
  withButton?: boolean
}) {
  const { t } = useI18n()
  const text =
    access === 'create' ? t('sub.noticeCreate') : access === 'own_lapsed' ? t('sub.noticeOwn') : t('sub.noticeOwner')
  return (
    <div className="subscription-notice" role="status">
      <p>{text}</p>
      {withButton && access !== 'owner_lapsed' && <SubscribeButton />}
    </div>
  )
}
