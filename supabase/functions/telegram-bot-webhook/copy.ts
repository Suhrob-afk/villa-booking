/**
 * Every string the bot can say, keyed by language code. A plain object on
 * purpose — three languages and about a dozen keys do not need an i18n
 * runtime, and keeping it flat means a translator can read the whole bot in
 * one screen.
 */

export type Lang = 'en' | 'ru' | 'uz'

export const LANGS: Lang[] = ['en', 'ru', 'uz']

export function isLang(value: unknown): value is Lang {
  return typeof value === 'string' && (LANGS as string[]).includes(value)
}

/** Step 1 has to be readable before we know the language, so it is trilingual. */
export const LANGUAGE_PROMPT = [
  'Please choose your language.',
  'Пожалуйста, выберите язык.',
  'Iltimos, tilni tanlang.',
].join('\n')

export const LANGUAGE_BUTTONS: { text: string; lang: Lang }[] = [
  { text: 'English', lang: 'en' },
  { text: 'Русский', lang: 'ru' },
  { text: "O'zbekcha", lang: 'uz' },
]

interface Copy {
  askPhone: string
  phoneButton: string
  phoneNotYours: string
  phoneInvalid: string
  askName: string
  nameTooShort: string
  askIdentity: string
  identityOwner: string
  identityMakler: string
  identityBoth: string
  identityBrowsing: string
  done: (name: string, oikozId: string) => string
  openApp: string
  alreadyDone: (name: string, oikozId: string) => string
  roleUpdated: string
  languageUpdated: string
  restartHint: string
  unexpected: string
}

export const COPY: Record<Lang, Copy> = {
  en: {
    askPhone: 'Thanks! Now share your phone number so owners and managers can reach you.\n\nTap the button below — Telegram sends it for you.',
    phoneButton: '📱 Share my number',
    phoneNotYours: 'That looks like someone else’s contact. Please share your own number.',
    phoneInvalid: 'That doesn’t look like a phone number. Use the button below, or type it like +998901234567.',
    askName: 'Got it. What is your full name?',
    nameTooShort: 'Please send your full name (at least 2 characters).',
    askIdentity: 'Last question — how will you use Oikoz?',
    identityOwner: '🏡 Villa Owner',
    identityMakler: '🤝 Makler',
    identityBoth: '🏡🤝 Both',
    identityBrowsing: '👀 Just browsing',
    done: (name, oikozId) =>
      `You’re all set, ${name}.\n\nYour Oikoz reference: ${oikozId}\n\nTap below to open the app.`,
    openApp: 'Open App',
    alreadyDone: (name, oikozId) =>
      `Welcome back, ${name}. Your Oikoz ID is ${oikozId}.\n\nTap below to open the app.`,
    roleUpdated: 'Your role has been updated.',
    languageUpdated: 'Language updated — I’ll write to you in English from now on.',
    restartHint: 'Send /start to begin.',
    unexpected: 'Let’s finish the step above first.',
  },

  ru: {
    askPhone: 'Спасибо! Теперь поделитесь номером телефона, чтобы владельцы и маклеры могли с вами связаться.\n\nНажмите кнопку ниже — Telegram отправит его сам.',
    phoneButton: '📱 Отправить мой номер',
    phoneNotYours: 'Похоже, это чужой контакт. Пожалуйста, отправьте свой номер.',
    phoneInvalid: 'Это не похоже на номер телефона. Нажмите кнопку ниже или введите в формате +998901234567.',
    askName: 'Принято. Как вас зовут? Укажите имя и фамилию.',
    nameTooShort: 'Пожалуйста, отправьте полное имя (минимум 2 символа).',
    askIdentity: 'Последний вопрос — как вы будете пользоваться Oikoz?',
    identityOwner: '🏡 Владелец виллы',
    identityMakler: '🤝 Маклер',
    identityBoth: '🏡🤝 И то, и другое',
    identityBrowsing: '👀 Просто смотрю',
    done: (name, oikozId) =>
      `Готово, ${name}.\n\nВаш номер Oikoz: ${oikozId}\n\nНажмите кнопку ниже, чтобы открыть приложение.`,
    openApp: 'Открыть приложение',
    alreadyDone: (name, oikozId) =>
      `С возвращением, ${name}. Ваш Oikoz ID: ${oikozId}.\n\nНажмите кнопку ниже, чтобы открыть приложение.`,
    roleUpdated: 'Ваша роль обновлена.',
    languageUpdated: 'Язык обновлён — теперь я буду писать вам по-русски.',
    restartHint: 'Отправьте /start, чтобы начать.',
    unexpected: 'Давайте сначала завершим текущий шаг.',
  },

  uz: {
    askPhone: 'Rahmat! Endi telefon raqamingizni ulashing — egalar va maklerlar siz bilan bog‘lana olishadi.\n\nQuyidagi tugmani bosing, Telegram o‘zi yuboradi.',
    phoneButton: '📱 Raqamimni yuborish',
    phoneNotYours: 'Bu boshqa odamning kontaktiga o‘xshaydi. Iltimos, o‘z raqamingizni yuboring.',
    phoneInvalid: 'Bu telefon raqamiga o‘xshamaydi. Quyidagi tugmadan foydalaning yoki +998901234567 ko‘rinishida yozing.',
    askName: 'Qabul qilindi. Ism va familiyangiz nima?',
    nameTooShort: 'Iltimos, to‘liq ismingizni yuboring (kamida 2 ta belgi).',
    askIdentity: 'Oxirgi savol — Oikoz’dan qanday foydalanasiz?',
    identityOwner: '🏡 Villa egasi',
    identityMakler: '🤝 Makler',
    identityBoth: '🏡🤝 Ikkalasi ham',
    identityBrowsing: '👀 Shunchaki ko‘rmoqchiman',
    done: (name, oikozId) =>
      `Hammasi tayyor, ${name}.\n\nSizning Oikoz raqamingiz: ${oikozId}\n\nIlovani ochish uchun quyidagi tugmani bosing.`,
    openApp: 'Ilovani ochish',
    alreadyDone: (name, oikozId) =>
      `Xush kelibsiz, ${name}. Sizning Oikoz ID: ${oikozId}.\n\nIlovani ochish uchun quyidagi tugmani bosing.`,
    roleUpdated: 'Rolingiz yangilandi.',
    languageUpdated: 'Til yangilandi — endi sizga o‘zbekcha yozaman.',
    restartHint: 'Boshlash uchun /start yuboring.',
    unexpected: 'Avval yuqoridagi bosqichni tugatamiz.',
  },
}
