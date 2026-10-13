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
  identityClient: string
  done: (name: string, oikozId: string) => string
  openApp: string
  alreadyDone: (name: string, oikozId: string) => string
  /** Names the role just chosen, e.g. "Your role is now: Client." */
  roleUpdated: (role: string) => string
  /** Each identity as a plain noun, for roleUpdated. Keyed like the callback data. */
  roleNames: Record<'browsing' | 'owner' | 'makler' | 'both', string>
  languageUpdated: string
  restartHint: string
  unexpected: string
  phoneSaved: string
  phoneSaveFailed: string

  // ------------------------------------------------------- subscription --
  subscribeButton: string
  /** What it costs and what it unlocks. */
  subscribeIntro: (price: string, days: number) => string
  /** Added to the intro for someone already paid: paying now extends. */
  subscribeActiveNote: (until: string, days: number) => string
  subscribeQrMissing: string
  receiptReceived: string
  receiptAlreadyPending: string
  receiptAskScreenshot: string
  receiptTooLarge: string
  receiptFailed: string
  // A guest's deposit receipt, for a booking from the public page.
  /** Asked once the deep link checks out: what the receipt is for. */
  depositReceiptAsk: (villa: string, dates: string, amount: string) => string
  depositSendWithout: string
  depositReceiptAskAgain: string
  depositReceiptReceived: string
  depositSentWithout: string
  depositReceiptTooLarge: string
  depositReceiptFailed: string
  /** Two of the guest's bookings are waiting for a receipt and none was named. */
  depositReceiptWhich: string
  depositReceiptPicked: (villa: string, dates: string) => string
  /** Generic on purpose: never says whether the booking in the link exists. */
  depositLinkInvalid: string
  depositAlreadySent: string
  depositHoldEnded: string
  openBooking: string
  subscriptionActive: (until: string) => string
  subscriptionRejected: (price: string) => string
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
    identityClient: '👤 Client',
    done: (name, oikozId) =>
      `You’re all set, ${name}.\n\nYour Oikoz reference: ${oikozId}\n\nTap below to open the app.`,
    openApp: 'Open App',
    alreadyDone: (name, oikozId) =>
      `Welcome back, ${name}. Your Oikoz ID is ${oikozId}.\n\nTap below to open the app.`,
    roleUpdated: (role) => `Your role is now: ${role}.`,
    roleNames: { browsing: 'Client', owner: 'Villa Owner', makler: 'Makler', both: 'Villa Owner and Makler' },
    languageUpdated: 'Language updated — I’ll write to you in English from now on.',
    restartHint: 'Send /start to begin.',
    unexpected: 'Let’s finish the step above first.',
    phoneSaved: 'Thanks — your number is saved. Go back to the booking page to finish your reservation.',
    phoneSaveFailed: 'Sorry, I couldn’t save your number. Please go back to the booking page and try again.',
    subscribeButton: '💳 Subscribe',
    subscribeIntro: (price, days) =>
      `💳 <b>Oikoz subscription — ${price} for ${days} days</b>\n\n` +
      'It unlocks adding and editing your villas, logging and managing bookings, blocking dates, and taking new bookings from your booking link. Your maklers can work on your villas too.\n\n' +
      'Without it, everything stays visible, but read-only.',
    subscribeActiveNote: (until, days) => `Your subscription is active until ${until}. Paying now adds ${days} more days.`,
    subscribeQrMissing: 'The QR code isn’t available right now. Please try /subscribe again a little later.',
    receiptReceived: 'Received. I’ll confirm shortly.',
    receiptAlreadyPending: 'Your previous receipt is still being checked. I’ll let you know shortly.',
    receiptAskScreenshot: 'Please send the payment receipt as a screenshot.',
    receiptTooLarge: 'That file is too large. Please send a screenshot of the receipt instead.',
    receiptFailed: 'Sorry, I couldn’t save your receipt. Please send it again.',
    depositReceiptAsk: (villa, dates, amount) =>
      `🧾 <b>Send a screenshot of your deposit transfer here.</b>\n\n🏡 ${villa}\n📅 ${dates}\n💳 ${amount}\n\nI’ll pass it to the owner, who checks the transfer and confirms your booking. No screenshot? Tap “Send without receipt”.`,
    depositSendWithout: 'Send without receipt',
    depositReceiptAskAgain:
      'Please send the receipt as a photo or an image — a screenshot works best. If you can’t, tap “Send without receipt”.',
    depositReceiptReceived:
      '✅ Receipt received and sent to the owner. They’ll check the transfer and confirm your booking — I’ll let you know here.',
    depositSentWithout:
      '✅ Sent to the owner without a receipt. They’ll check the transfer and confirm your booking — I’ll let you know here.',
    depositReceiptTooLarge: 'That file is too large (over 10 MB). Please send a screenshot instead.',
    depositReceiptFailed: 'Sorry, I couldn’t save that receipt. Please send it again, or tap “Send without receipt”.',
    depositReceiptWhich: 'Which booking is this receipt for? Tap it, then send the screenshot again.',
    depositReceiptPicked: (villa, dates) => `🧾 Send the receipt screenshot for:\n\n🏡 ${villa}\n📅 ${dates}`,
    depositLinkInvalid: 'This link isn’t active. Open the booking page and tap “I’ve sent the deposit” there.',
    depositAlreadySent: 'You’ve already told the owner about this deposit. I’ll message you here when they reply.',
    depositHoldEnded: 'This reservation is no longer on hold. Open the booking page to see where it stands.',
    openBooking: 'Open booking',
    subscriptionActive: (until) => `✅ Payment confirmed. Your subscription is active until ${until}.`,
    subscriptionRejected: (price) =>
      `❌ We couldn’t find your payment. Please check that you paid exactly ${price}, then send the receipt screenshot here again.`,
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
    identityClient: '👤 Клиент',
    done: (name, oikozId) =>
      `Готово, ${name}.\n\nВаш номер Oikoz: ${oikozId}\n\nНажмите кнопку ниже, чтобы открыть приложение.`,
    openApp: 'Открыть приложение',
    alreadyDone: (name, oikozId) =>
      `С возвращением, ${name}. Ваш Oikoz ID: ${oikozId}.\n\nНажмите кнопку ниже, чтобы открыть приложение.`,
    roleUpdated: (role) => `Ваша роль теперь: ${role}.`,
    roleNames: { browsing: 'Клиент', owner: 'Владелец виллы', makler: 'Маклер', both: 'Владелец виллы и маклер' },
    languageUpdated: 'Язык обновлён — теперь я буду писать вам по-русски.',
    restartHint: 'Отправьте /start, чтобы начать.',
    unexpected: 'Давайте сначала завершим текущий шаг.',
    phoneSaved: 'Спасибо — номер сохранён. Вернитесь на страницу бронирования, чтобы завершить бронь.',
    phoneSaveFailed: 'Не удалось сохранить номер. Вернитесь на страницу бронирования и попробуйте ещё раз.',
    subscribeButton: '💳 Оформить подписку',
    subscribeIntro: (price, days) =>
      `💳 <b>Подписка Oikoz — ${price} на ${days} дней</b>\n\n` +
      'С ней можно добавлять и редактировать виллы, вносить брони и управлять ими, блокировать даты и принимать новые брони по вашей ссылке. Ваши маклеры тоже смогут работать с вашими виллами.\n\n' +
      'Без подписки всё остаётся видно, но только для просмотра.',
    subscribeActiveNote: (until, days) => `Ваша подписка активна до ${until}. Оплата сейчас добавит ещё ${days} дней.`,
    subscribeQrMissing: 'QR-код сейчас недоступен. Попробуйте /subscribe ещё раз чуть позже.',
    receiptReceived: 'Получено. Скоро подтвержу.',
    receiptAlreadyPending: 'Ваш предыдущий чек ещё проверяется. Скоро сообщу результат.',
    receiptAskScreenshot: 'Пожалуйста, отправьте чек об оплате в виде скриншота.',
    receiptTooLarge: 'Файл слишком большой. Пожалуйста, отправьте скриншот чека.',
    receiptFailed: 'Не удалось сохранить чек. Пожалуйста, отправьте его ещё раз.',
    depositReceiptAsk: (villa, dates, amount) =>
      `🧾 <b>Отправьте сюда скриншот перевода депозита.</b>\n\n🏡 ${villa}\n📅 ${dates}\n💳 ${amount}\n\nЯ передам его владельцу: он проверит перевод и подтвердит бронь. Нет скриншота? Нажмите «Отправить без чека».`,
    depositSendWithout: 'Отправить без чека',
    depositReceiptAskAgain:
      'Пожалуйста, отправьте чек как фото или изображение — лучше всего скриншот. Если не получается, нажмите «Отправить без чека».',
    depositReceiptReceived:
      '✅ Чек получен и отправлен владельцу. Он проверит перевод и подтвердит бронь — я сообщу вам здесь.',
    depositSentWithout:
      '✅ Отправлено владельцу без чека. Он проверит перевод и подтвердит бронь — я сообщу вам здесь.',
    depositReceiptTooLarge: 'Файл слишком большой (больше 10 МБ). Пожалуйста, отправьте скриншот.',
    depositReceiptFailed: 'Не удалось сохранить чек. Отправьте его ещё раз или нажмите «Отправить без чека».',
    depositReceiptWhich: 'К какой брони этот чек? Нажмите на неё и отправьте скриншот ещё раз.',
    depositReceiptPicked: (villa, dates) => `🧾 Отправьте скриншот чека для брони:\n\n🏡 ${villa}\n📅 ${dates}`,
    depositLinkInvalid: 'Эта ссылка неактивна. Откройте страницу бронирования и нажмите там «Я отправил(а) депозит».',
    depositAlreadySent: 'Вы уже сообщили владельцу об этом депозите. Я напишу вам здесь, когда он ответит.',
    depositHoldEnded: 'Эта бронь больше не удерживается. Откройте страницу бронирования, чтобы узнать её статус.',
    openBooking: 'Открыть бронь',
    subscriptionActive: (until) => `✅ Оплата подтверждена. Ваша подписка активна до ${until}.`,
    subscriptionRejected: (price) =>
      `❌ Мы не нашли вашу оплату. Проверьте, что оплатили ровно ${price}, и отправьте скриншот чека сюда ещё раз.`,
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
    identityClient: '👤 Mijoz',
    done: (name, oikozId) =>
      `Hammasi tayyor, ${name}.\n\nSizning Oikoz raqamingiz: ${oikozId}\n\nIlovani ochish uchun quyidagi tugmani bosing.`,
    openApp: 'Ilovani ochish',
    alreadyDone: (name, oikozId) =>
      `Xush kelibsiz, ${name}. Sizning Oikoz ID: ${oikozId}.\n\nIlovani ochish uchun quyidagi tugmani bosing.`,
    roleUpdated: (role) => `Endi sizning rolingiz: ${role}.`,
    roleNames: { browsing: 'Mijoz', owner: 'Villa egasi', makler: 'Makler', both: 'Villa egasi va makler' },
    languageUpdated: 'Til yangilandi — endi sizga o‘zbekcha yozaman.',
    restartHint: 'Boshlash uchun /start yuboring.',
    unexpected: 'Avval yuqoridagi bosqichni tugatamiz.',
    phoneSaved: 'Rahmat — raqamingiz saqlandi. Bronni yakunlash uchun bron sahifasiga qayting.',
    phoneSaveFailed: 'Raqamingizni saqlab bo‘lmadi. Bron sahifasiga qaytib, qaytadan urinib ko‘ring.',
    subscribeButton: '💳 Obuna bo‘lish',
    subscribeIntro: (price, days) =>
      `💳 <b>Oikoz obunasi — ${days} kunga ${price}</b>\n\n` +
      'Obuna bilan villalaringizni qo‘shish va tahrirlash, bronlarni kiritish va boshqarish, sanalarni band qilish hamda havolangiz orqali yangi bronlarni qabul qilish mumkin. Maklerlaringiz ham villalaringiz bilan ishlay oladi.\n\n' +
      'Obunasiz hammasi ko‘rinadi, lekin faqat ko‘rish uchun.',
    subscribeActiveNote: (until, days) =>
      `Obunangiz ${until} gacha faol. Hozir to‘lasangiz, yana ${days} kun qo‘shiladi.`,
    subscribeQrMissing: 'QR-kod hozircha mavjud emas. Birozdan so‘ng /subscribe buyrug‘ini qayta yuboring.',
    receiptReceived: 'Qabul qilindi. Tez orada tasdiqlayman.',
    receiptAlreadyPending: 'Oldingi chekingiz hali tekshirilmoqda. Tez orada xabar beraman.',
    receiptAskScreenshot: 'Iltimos, to‘lov chekini skrinshot ko‘rinishida yuboring.',
    receiptTooLarge: 'Fayl juda katta. Iltimos, chekning skrinshotini yuboring.',
    receiptFailed: 'Chekni saqlab bo‘lmadi. Iltimos, uni qayta yuboring.',
    depositReceiptAsk: (villa, dates, amount) =>
      `🧾 <b>Depozit o‘tkazmasining skrinshotini shu yerga yuboring.</b>\n\n🏡 ${villa}\n📅 ${dates}\n💳 ${amount}\n\nUni egasiga yuboraman: u o‘tkazmani tekshirib, bronni tasdiqlaydi. Skrinshot yo‘qmi? «Cheksiz yuborish» tugmasini bosing.`,
    depositSendWithout: 'Cheksiz yuborish',
    depositReceiptAskAgain:
      'Iltimos, chekni rasm yoki tasvir sifatida yuboring — skrinshot eng yaxshisi. Imkoni bo‘lmasa, «Cheksiz yuborish» tugmasini bosing.',
    depositReceiptReceived:
      '✅ Chek qabul qilindi va egasiga yuborildi. U o‘tkazmani tekshirib, bronni tasdiqlaydi — sizga shu yerda xabar beraman.',
    depositSentWithout:
      '✅ Egasiga cheksiz yuborildi. U o‘tkazmani tekshirib, bronni tasdiqlaydi — sizga shu yerda xabar beraman.',
    depositReceiptTooLarge: 'Fayl juda katta (10 MB dan ortiq). Iltimos, skrinshot yuboring.',
    depositReceiptFailed: 'Chekni saqlab bo‘lmadi. Uni qayta yuboring yoki «Cheksiz yuborish» tugmasini bosing.',
    depositReceiptWhich: 'Bu chek qaysi bron uchun? Uni bosing va skrinshotni qayta yuboring.',
    depositReceiptPicked: (villa, dates) => `🧾 Quyidagi bron uchun chek skrinshotini yuboring:\n\n🏡 ${villa}\n📅 ${dates}`,
    depositLinkInvalid: 'Bu havola faol emas. Bron sahifasini oching va u yerda «Depozitni yubordim» tugmasini bosing.',
    depositAlreadySent: 'Siz bu depozit haqida egasiga allaqachon xabar bergansiz. U javob berganda shu yerda yozaman.',
    depositHoldEnded: 'Bu bron endi band qilib turilmayapti. Holatini bilish uchun bron sahifasini oching.',
    openBooking: 'Bronni ochish',
    subscriptionActive: (until) => `✅ To‘lov tasdiqlandi. Obunangiz ${until} gacha faol.`,
    subscriptionRejected: (price) =>
      `❌ To‘lovingizni topa olmadik. Aynan ${price} to‘laganingizni tekshiring va chek skrinshotini shu yerga qayta yuboring.`,
  },
}
