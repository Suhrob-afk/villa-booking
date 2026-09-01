import { useAuth } from '../lib/auth'
import { useI18n } from '../lib/i18n'

/**
 * Shown when someone opens the Mini App without having finished the bot
 * conversation. Registration -- language, phone, name, owner/makler -- belongs
 * to the bot, so this screen collects nothing; it just sends them back.
 *
 * No language switcher here: there is no users row to write it to yet, and the
 * bot asks the language question first thing anyway.
 */
export default function Onboarding() {
  const { pendingTelegram, retry } = useAuth()
  const { t } = useI18n()

  return (
    <main className="screen">
      <div className="center-state">
        <h2>{t('onboarding.title')}</h2>
        <p>
          {pendingTelegram
            ? t('onboarding.bodyNamed', { name: pendingTelegram.name })
            : t('onboarding.body')}
        </p>
        <p>{t('onboarding.thenOpen')}</p>
        <button type="button" className="button button-secondary button-small" onClick={retry}>
          {t('onboarding.retry')}
        </button>
      </div>
    </main>
  )
}
