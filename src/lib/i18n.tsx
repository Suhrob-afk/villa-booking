import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { updateOwnLanguage } from './api'
import { useAuth } from './auth'
import { isLang, plural as pluralize, translate, type PluralBase, type StringKey, type Vars } from './strings'
import type { Lang } from './types'

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
  const userLang = isLang(user?.language) ? user!.language : 'en'
  const [lang, setLangState] = useState<Lang>(userLang)

  // Adopt whatever the server says on sign-in and on every foreground re-auth.
  // A switch made here has already written the same value onto the user row
  // below, so this never fights an in-app change.
  useEffect(() => {
    setLangState(userLang)
  }, [userLang])

  const setLang = useCallback(
    async (next: Lang) => {
      if (!user) return
      const previous = lang
      setLangState(next) // optimistic: the UI flips before the round trip
      try {
        await updateOwnLanguage(user.id, next)
        refreshUser({ ...user, language: next })
      } catch (err) {
        setLangState(previous)
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
