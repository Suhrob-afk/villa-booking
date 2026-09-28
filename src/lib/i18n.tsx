import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { updateOwnLanguage } from './api'
import { useAuth } from './auth'
import {
  isLang,
  plural as pluralize,
  setActiveLang,
  translate,
  type PluralBase,
  type StringKey,
  type Vars,
} from './strings'
import { telegramLanguageCode } from './telegram'
import type { Lang } from './types'

/** Last language this device saw, so a cold start does not have to guess. */
const STORAGE_KEY = 'oikoz.lang'

function readStoredLang(): Lang | null {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    return isLang(stored) ? stored : null
  } catch {
    // Private mode, or storage disabled: fall through to the other sources.
    return null
  }
}

function storeLang(lang: Lang): void {
  try {
    localStorage.setItem(STORAGE_KEY, lang)
  } catch {
    // Not being able to remember is survivable; crashing over it is not.
  }
}

/**
 * What to show before the signed-in user's own language is known.
 *
 * Sign-in is a network round trip, and until it returns there is no users row
 * to read `language` from. Defaulting to English for that whole window is what
 * made the app look English on slower devices -- notably Android, where the
 * gap is long enough to read rather than blink past. So: what this device last
 * saw, else the locale Telegram itself reports, and only then English.
 */
function initialLang(): Lang {
  const stored = readStoredLang()
  if (stored) return stored
  const fromTelegram = telegramLanguageCode()
  return isLang(fromTelegram) ? fromTelegram : 'en'
}

interface I18n {
  lang: Lang
  t: (key: StringKey, vars?: Vars) => string
  /** Counted text — Russian needs three forms where English needs two. */
  tn: (base: PluralBase, count: number, vars?: Vars) => string
  /** Writes users.language, then re-renders. Rejects if the write fails. */
  setLang: (next: Lang) => Promise<void>
}

const I18nContext = createContext<I18n | null>(null)

/**
 * Language is a property of the user row, not of the device: the bot's
 * /language command and this app write the same column, so whichever one a
 * person used last is what both speak.
 *
 * The signed-in user is the source of truth. auth re-reads it whenever the
 * Mini App comes back to the foreground, which is what makes a change made in
 * the bot show up here on next open without a reload.
 */
export function LanguageProvider({ children }: { children: ReactNode }) {
  const { user, refreshUser } = useAuth()
  const [lang, setLangState] = useState<Lang>(initialLang)
  const serverLang = user?.language

  // The signed-in user's language wins the moment it is known, on sign-in and
  // on every foreground re-auth -- that is what carries a change made with the
  // bot's /language across. Until then the UI keeps whatever it opened with
  // rather than being forced back to a default: note this no longer falls back
  // to 'en' when `user` is null, which previously reset the language on any
  // render where the user was not loaded yet.
  useEffect(() => {
    if (!isLang(serverLang)) return
    setLangState(serverLang)
    storeLang(serverLang)
  }, [serverLang])

  // Keep the non-React mirror in step, for messages thrown outside components.
  useEffect(() => {
    setActiveLang(lang)
  }, [lang])

  const setLang = useCallback(
    async (next: Lang) => {
      if (!user) return
      const previous = lang
      setLangState(next) // optimistic: the UI flips before the round trip
      storeLang(next)
      try {
        await updateOwnLanguage(user.id, next)
        refreshUser({ ...user, language: next })
      } catch (err) {
        setLangState(previous)
        storeLang(previous)
        throw err
      }
    },
    [lang, refreshUser, user],
  )

  const value = useMemo<I18n>(
    () => ({
      lang,
      t: (key, vars) => translate(lang, key, vars),
      tn: (base, count, vars) => pluralize(lang, base, count, vars),
      setLang,
    }),
    [lang, setLang],
  )

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>
}

export function useI18n(): I18n {
  const context = useContext(I18nContext)
  if (!context) throw new Error('useI18n must be used inside <LanguageProvider>')
  return context
}
