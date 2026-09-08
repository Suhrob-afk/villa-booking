/**
 * Every string the Mini App can show, keyed by language code — the same plain
 * lookup the bot uses in supabase/functions/telegram-bot-webhook/copy.ts. Three
 * languages and a few hundred keys do not need an i18n runtime, and keeping it
 * flat means a translator can work through the whole app in one file.
 *
 * Keys carry a screen prefix. Placeholders are `{name}` and are substituted by
 * translate(); anything counted goes through plural() instead, which picks the
 * right `_one` / `_few` / `_many` / `_other` variant for the language.
 */

import type { Lang } from './types'

export const LANGS: Lang[] = ['en', 'ru', 'uz']

export function isLang(value: unknown): value is Lang {
  return typeof value === 'string' && (LANGS as string[]).includes(value)
}

/** Each language named in itself — never translated, that is the whole point. */
export const LANGUAGE_NAMES: Record<Lang, string> = {
  en: 'English',
  ru: 'Русский',
  uz: "O'zbekcha",
}

// ------------------------------------------------------------- calendar ----

export const MONTHS: Record<Lang, string[]> = {
  en: ['January', 'February', 'March', 'April', 'May', 'June',
       'July', 'August', 'September', 'October', 'November', 'December'],
  ru: ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
       'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'],
  uz: ['yanvar', 'fevral', 'mart', 'aprel', 'may', 'iyun',
       'iyul', 'avgust', 'sentabr', 'oktabr', 'noyabr', 'dekabr'],
}

/**
 * Russian months are listed above in the genitive ("5 января"), which is what
 * a date needs but not what a standalone month heading needs — so the heading
 * form is kept separately rather than derived.
 */
export const MONTHS_STANDALONE: Record<Lang, string[]> = {
  en: MONTHS.en,
  ru: ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь',
       'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'],
  uz: ['Yanvar', 'Fevral', 'Mart', 'Aprel', 'May', 'Iyun',
       'Iyul', 'Avgust', 'Sentabr', 'Oktabr', 'Noyabr', 'Dekabr'],
}

export const MONTHS_SHORT: Record<Lang, string[]> = {
  en: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
  ru: ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'],
  uz: ['yan', 'fev', 'mar', 'apr', 'may', 'iyn', 'iyl', 'avg', 'sen', 'okt', 'noy', 'dek'],
}

/** Monday-first, matching the calendar grid. */
export const WEEKDAYS: Record<Lang, string[]> = {
  en: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'],
  ru: ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'],
  uz: ['Du', 'Se', 'Ch', 'Pa', 'Ju', 'Sh', 'Ya'],
}

export const WEEKDAYS_LONG: Record<Lang, string[]> = {
  en: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'],
  ru: ['понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота', 'воскресенье'],
  uz: ['dushanba', 'seshanba', 'chorshanba', 'payshanba', 'juma', 'shanba', 'yakshanba'],
}

// -------------------------------------------------------------- plurals ----

type PluralCategory = 'one' | 'few' | 'many' | 'other'

/**
 * English has two forms, Russian has three (1 ночь / 2 ночи / 5 ночей), and
 * Uzbek does not inflect after a numeral at all. Small enough to spell out.
 */
function pluralCategory(lang: Lang, count: number): PluralCategory {
  const n = Math.abs(Math.trunc(count))
  if (lang === 'ru') {
    const mod10 = n % 10
    const mod100 = n % 100
    if (mod10 === 1 && mod100 !== 11) return 'one'
    if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return 'few'
    return 'many'
  }
  if (lang === 'uz') return 'other'
  return n === 1 ? 'one' : 'other'
}

const en = {
  // ------------------------------------------------------------ common --
  'common.back': 'Back',
  'common.close': 'Close',
  'common.remove': 'Remove',
  'common.loading': 'Loading…',
  'common.signingIn': 'Signing you in…',
  'common.signInFailed': 'Sign-in failed.',
  'common.errorTitle': 'Something went wrong',
  'common.tryAgain': 'Try again',
  'common.saving': 'Saving…',
  'common.saveChanges': 'Save changes',
  'common.language': 'Language',
  'common.paid': 'paid',
  'common.unpaid': 'unpaid',

  // ------------------------------------------------------------- plurals --
  'plural.nights_one': '{count} night',
  'plural.nights_few': '{count} nights',
  'plural.nights_many': '{count} nights',
  'plural.nights_other': '{count} nights',
  'plural.weekdayNights_one': '{count} weekday night',
  'plural.weekdayNights_few': '{count} weekday nights',
  'plural.weekdayNights_many': '{count} weekday nights',
  'plural.weekdayNights_other': '{count} weekday nights',
  'plural.weekendNights_one': '{count} weekend night',
  'plural.weekendNights_few': '{count} weekend nights',
  'plural.weekendNights_many': '{count} weekend nights',
  'plural.weekendNights_other': '{count} weekend nights',
  'plural.guests_one': '{count} guest',
  'plural.guests_few': '{count} guests',
  'plural.guests_many': '{count} guests',
  'plural.guests_other': '{count} guests',

  // ----------------------------------------------------------- tab bar --
  'tabs.villas': 'Villas',
  'tabs.commissions': 'Commissions',

  // -------------------------------------------------------- onboarding --
  'onboarding.title': 'Finish signing up in the chat',
  'onboarding.bodyNamed':
    '{name}, your account isn’t set up yet. Send /start to the bot and answer a few quick questions — language, phone number, your name, and how you’ll use Oikoz.',
  'onboarding.body':
    'Your account isn’t set up yet. Send /start to the bot and answer a few quick questions — language, phone number, your name, and how you’ll use Oikoz.',
  'onboarding.thenOpen': 'Once that’s done, tap “Open App” in the chat and you’ll land straight here.',
  'onboarding.retry': 'I’ve done that — try again',

  // -------------------------------------------------------------- home --
  'home.roleOwnerMakler': 'Owner & Makler',
  'home.roleOwner': 'Owner',
  'home.roleMakler': 'Makler',
  'home.roleClient': 'Client',
  'home.addVillaAria': 'Add villa',
  'home.myVillas': 'My Villas',
  'home.assignedVillas': 'Villas Assigned to Me',
  'home.noVillasTitle': 'No villas yet',
  'home.noVillasBody': 'Add your first villa to set its rates and start taking bookings.',
  'home.addVilla': 'Add villa',
  'home.noAssignedTitle': 'No villas assigned yet',
  'home.noAssignedBody': 'Give an owner your Oikoz reference and they can add you:',
  'home.clientTitle': 'This page isn’t ready yet',
  'home.clientBody': 'Nothing to show here for now. We’ll let you know in the chat when it is.',
  'home.noLocation': 'No location set',
  'home.rateWeekday': 'Mon–Fri',
  'home.rateWeekend': 'Sat–Sun',
  'home.rateCommission': 'Commission',

  // ---------------------------------------------------------- calendar --
  'calendar.prevMonth': 'Previous month',
  'calendar.nextMonth': 'Next month',
  'calendar.legendAvailable': 'Available',
  'calendar.legendBooked': 'Booked',
  'calendar.legendBlocked': 'Blocked',
  'calendar.legendPast': 'Past',
  'calendar.dayBooked': '{date} — booked by {name}',
  'calendar.dayBlocked': '{date} — blocked',
  'calendar.dayAvailable': '{date} — available',
  'calendar.dayUnavailable': '{date} — unavailable',

  // ----------------------------------------------------- villa calendar --
  'villa.setupAria': 'Villa setup',
  'villa.nightsBooked': 'Nights booked',
  'villa.yourPayout': 'Your payout',
  'villa.yourCommission': 'Your commission',
  'villa.notBooked': 'Not booked',
  'villa.blockDates': 'Block these dates',
  'villa.logBooking': 'Log a booking',
  'villa.newBooking': 'New booking',
  'villa.upcoming': 'Upcoming',
  'villa.nothingBookedTitle': 'Nothing booked yet',
  'villa.nothingBookedOwner': 'Bookings your managers create will show up here.',
  'villa.nothingBookedMakler': 'Tap an available day to add a booking.',
  'villa.depositPending': 'Deposit pending',
  'villa.rowPayout': 'payout {amount}',
  'villa.rowYou': 'you {amount}',
  'villa.rowOtherMakler': 'another makler',
  'villa.weekendRate': 'Weekend rate',
  'villa.weekdayRate': 'Weekday rate',
  'villa.deposit': 'Deposit',
  'villa.bookThisDate': 'Book this date',
  'villa.blockFrom': 'From {date}',
  'villa.blockUntilLabel': 'Blocked until (this day stays bookable)',
  'villa.blockReasonLabel': 'Reason',
  'villa.blocking': 'Blocking…',
  'villa.blockSubmit': 'Block dates',
  'villa.notAvailable': 'Not available',
  'villa.unblocking': 'Unblocking…',
  'villa.unblock': 'Unblock',
  'villa.unblockConfirm': 'Unblock these dates?',
  'villa.closedByOwner': 'These dates are closed by the owner.',
  'blockReason.owner_use': 'Owner use',
  'blockReason.maintenance': 'Maintenance',
  'blockReason.off_market': 'Off market',

  // ------------------------------------------------------- villa setup --
  'setup.titleNew': 'New villa',
  'setup.title': 'Villa setup',
  'setup.ownerOnly': 'Only the villa owner can change rates and commission.',
  'setup.nameRequired': 'Give the villa a name.',
  'setup.referenceRequired': 'Enter the makler’s Oikoz reference.',
  'setup.removeMaklerConfirm': 'Remove {name} from this villa?',
  'setup.deleteVillaConfirm': 'Delete this villa and all of its bookings? This cannot be undone.',
  'setup.nameLabel': 'Villa name',
  'setup.namePlaceholder': 'Chorvoq House',
  'setup.locationLabel': 'Location',
  'setup.locationPlaceholder': 'Chorvoq, Tashkent region',
  'setup.currencyLabel': 'Currency',
  'setup.capacityLabel': 'Capacity',
  'setup.currencyHint': 'Currency is set per villa — mixing USD and UZS villas is fine.',
  'setup.ratesTitle': 'Nightly rates',
  'setup.weekdayLabel': 'Weekday (Mon–Fri)',
  'setup.weekendLabel': 'Weekend (Sat–Sun)',
  'setup.ratesHint': 'Used to pre-fill booking totals. Maklers can still adjust a total by hand.',
  'setup.depositLabel': 'Default deposit',
  'setup.depositHint': 'Pre-fills each booking and can be raised per booking. Minimum {min}.',
  'setup.commissionTitle': 'Commission',
  'setup.commissionLabel': 'Makler commission %',
  'setup.platformFeeLabel': 'Platform fee %',
  'setup.commissionHint':
    'Changing these only affects new bookings — existing bookings keep the rate they were created with.',
  'setup.maklersTitle': 'Maklers',
  'setup.noMaklers': 'No maklers linked yet.',
  'setup.addMaklerLabel': 'Add makler by Oikoz reference',
  'setup.linkMakler': 'Link makler',
  'setup.addMaklerHint':
    'They need to have finished registration in the bot as a Makler. Their reference — like oikoz_id0001 — is shown on their own home screen.',
  'setup.createVilla': 'Create villa',
  'setup.deleteVilla': 'Delete villa',

  // ----------------------------------------------------------- booking --
  'booking.titleNew': 'New booking',
  'booking.title': 'Booking',
  'booking.cancelledNotice': 'This booking is cancelled. Its days are available again.',
  'booking.ownerReadOnly': 'You can view and cancel this booking. Only managers can edit the details.',
  'booking.clientNameLabel': 'Client name',
  'booking.clientNamePlaceholder': 'Full name',
  'booking.phoneLabel': 'Phone',
  'booking.phonePlaceholder': '+998 90 000 00 00',
  'booking.checkIn': 'Check-in',
  'booking.checkOut': 'Check-out',
  'booking.clientTypeLabel': 'Client type',
  'booking.clientTypeNone': 'Not specified',
  'booking.commissionTitle': 'Commission',
  'booking.creditedFor': '{reference} · credited for this booking',
  'booking.creditLabel': 'Credit a makler (optional)',
  'booking.creditChecking': 'Checking…',
  'booking.creditSubmit': 'Credit this makler',
  'booking.creditHint':
    'Leave blank if no makler brought this client — you keep the whole payout, less any platform fee.',
  'booking.priceTitle': 'Price',
  'booking.modePercentage': 'Commission %',
  'booking.modeOwnerNet': 'Owner’s net',
  'booking.ownerNetLabel': 'Owner’s net ({currency})',
  'booking.ownerNetHint':
    'What the owner is promised, whatever you charge. Pre-filled from the villa’s rates for these nights.',
  'booking.chargedLabel': 'Charged to client ({currency})',
  'booking.totalLabel': 'Total price ({currency})',
  'booking.resetTo': 'Reset to {amount}',
  'booking.chargedHint':
    'What the client actually pays. Anything above the owner’s net, less the platform fee, is yours.',
  'booking.totalHint': 'Pre-filled from the villa’s rates — adjust it for discounts or extras.',
  'booking.yourCommission': 'Your commission: {amount}',
  'booking.afterPlatformFee': '(after {amount} platform fee)',
  'booking.depositLabel': 'Deposit ({currency})',
  'booking.depositHint':
    'Held against damages, refunded on checkout — not part of the split below. Minimum {min}.',
  'booking.depositPaidQuestion': 'Deposit paid by client?',
  'booking.depositPaidYes': '✓ Paid',
  'booking.depositPaidNo': 'Not paid',
  'booking.splitTitle': 'Split',
  'booking.splitTotal': 'Total',
  'booking.splitPlatformFee': 'Platform fee ({rate})',
  'booking.splitNoMakler': 'Makler commission (none credited)',
  'booking.splitSpread': 'Makler commission (spread)',
  'booking.splitCommission': 'Makler commission ({rate})',
  'booking.splitOwnerPayout': 'Owner payout',
  'booking.splitDeposit': 'Deposit (held separately)',
  'booking.statusConfirmed': 'Confirmed',
  'booking.statusCancelled': 'Cancelled',
  'booking.commissionBadge': 'Commission {status}',
  'booking.notesLabel': 'Notes',
  'booking.notesPlaceholder': 'Arrival time, extras, deposit…',
  'booking.create': 'Create booking',
  'booking.cancel': 'Cancel booking',
  'booking.reopen': 'Reopen booking',
  'booking.cancelConfirm': 'Cancel this booking? Its days go back to available.',
  'booking.reopenConfirm': 'Reopen this booking and block those days again?',
  'booking.nightsSubtotal': '{nights} × {rate}',
  'clientType.family': 'Family',
  'clientType.friends_mixed': 'Friends (mixed)',
  'clientType.friends_men': 'Friends (men)',
  'clientType.friends_women': 'Friends (women)',
  'clientType.couple': 'Couple',
  'clientType.business': 'Business',
  'clientType.other': 'Other',

  // ------------------------------------------------- booking validation --
  'error.clientNameRequired': 'Enter the client’s name.',
  'error.datesRequired': 'Pick both dates.',
  'error.checkOutAfterCheckIn': 'Check-out must be after check-in.',
  'error.depositTooLow': 'Deposit can’t be below {min}.',
  'error.ownerNetRequired': 'Enter the owner’s net amount.',
  'error.totalBelowOwnerNet': 'Total price must be at least the owner’s net amount.',
  'error.notAMakler': 'That reference isn’t a registered makler.',
  'error.belongsToMakler': 'This booking belongs to a makler — you can cancel it or mark the deposit paid.',
  'error.datesOverlap': 'Those dates overlap another booking for this villa.',
  'error.ownersMayOnlyCancel': 'Owners can only cancel a booking, not edit it.',
  'error.ownerSettlesCommission': 'Only the villa owner can settle commissions.',
  'error.languageSaveFailed': 'Couldn’t save your language. Please try again.',

  // ------------------------------------------------------- commissions --
  'commissions.title': 'Commissions',
  'commissions.subtitleOwner': 'Owed to your maklers',
  'commissions.subtitleMakler': 'Your earnings',
  'commissions.asOwner': 'As owner',
  'commissions.asMakler': 'As makler',
  'commissions.tabCommission': 'Commission',
  'commissions.tabDeposits': 'Pending deposits',
  'commissions.maklerEmptyTitle': 'No commissions yet',
  'commissions.maklerEmptyBody': 'Bookings you create will show up here with what you earned.',
  'commissions.statUnpaid': 'Unpaid · {currency}',
  'commissions.statPaid': 'Paid · {currency}',
  'commissions.bookings': 'Bookings',
  'commissions.ownerEmptyTitle': 'Nothing owed yet',
  'commissions.ownerEmptyBody': 'Once your maklers book stays, what you owe them appears here.',
  'commissions.owedPerMakler': 'Owed per makler',
  'commissions.alreadySettled': '{amount} already settled',
  'commissions.nothingSettled': 'Nothing settled yet',
  'commissions.openCommission': 'Open commission',
  'commissions.allSettledTitle': 'All settled',
  'commissions.allSettledBody': 'Every commission on your villas has been marked paid.',
  'commissions.markPaid': 'Mark paid',
  'commissions.settled': 'Settled',
  'commissions.maklerFallback': 'Makler',
  'commissions.noDepositsTitle': 'No pending deposits',
  'commissions.noDepositsBody': 'Every confirmed booking has its deposit in.',
  'commissions.statOutstanding': 'Outstanding · {currency}',
  'commissions.awaitingDeposit': 'Awaiting deposit',
  'commissions.amountDue': '{amount} due',
  'commissions.markReceived': 'Mark received',

  // --------------------------------------------------------- breakdown --
  'breakdown.title': 'Breakdown',
  'breakdown.allVillas': 'All my villas',
  'breakdown.thisVilla': 'This villa',
  'breakdown.unitWeek': 'Week',
  'breakdown.unitMonth': 'Month',
  'breakdown.unitYear': 'Year',
  'breakdown.prevPeriod': 'Previous period',
  'breakdown.nextPeriod': 'Next period',
  'breakdown.nightsBooked': 'Nights booked',
  'breakdown.bookings': 'Bookings',
  'breakdown.emptyTitle': 'Nothing in this period',
  'breakdown.emptyWeek': 'Nothing checked in this week.',
  'breakdown.emptyMonth': 'Nothing checked in this month.',
  'breakdown.emptyYear': 'Nothing checked in this year.',
  'breakdown.payout': 'Payout',
  'breakdown.gross': 'Gross revenue',
  'breakdown.included': 'Bookings included',
  // ------------------------------------------------- retroactive logging --
  'booking.pastDateNotice':
    'You can log a booking for this date if you had one — it’ll be included in your revenue totals.',
  'booking.untitled': 'Booking',
  'booking.depositHintSimple':
    'Held against damages, refunded on checkout — separate from the price above. Minimum {min}.',
  'calendar.dayBookedNoName': '{date} — booked',
  'calendar.dayLoggable': '{date} — past, tap to log a booking',
  'plural.bookings_one': '{count} booking',
  'plural.bookings_few': '{count} bookings',
  'plural.bookings_many': '{count} bookings',
  'plural.bookings_other': '{count} bookings',

  // ------------------------------------------------------ villa removal --
  'setup.removeTitle': 'Remove villa',
  'setup.deleteHint': 'This villa has no bookings, so it can be deleted permanently.',
  'setup.archiveVilla': 'Archive villa',
  'setup.archiveHint':
    'This villa has {bookings} in its history. Archiving hides it from My Villas and keeps every booking, payout and commission exactly as they are.',
  'setup.archiveConfirm': 'Archive this villa? It leaves My Villas but keeps all of its history.',
  'setup.unarchiveVilla': 'Restore villa',
  'setup.archivedNotice': 'This villa is archived. It stays out of My Villas, and its revenue still counts.',
  'home.archivedToggle': 'Archived villas ({count})',
  'home.unarchive': 'Restore',
}

export type StringKey = keyof typeof en

const ru: Record<StringKey, string> = {
  // ------------------------------------------------------------ common --
  'common.back': 'Назад',
  'common.close': 'Закрыть',
  'common.remove': 'Убрать',
  'common.loading': 'Загрузка…',
  'common.signingIn': 'Выполняется вход…',
  'common.signInFailed': 'Не удалось войти.',
  'common.errorTitle': 'Что-то пошло не так',
  'common.tryAgain': 'Повторить',
  'common.saving': 'Сохранение…',
  'common.saveChanges': 'Сохранить изменения',
  'common.language': 'Язык',
  'common.paid': 'выплачено',
  'common.unpaid': 'не выплачено',

  // ------------------------------------------------------------- plurals --
  'plural.nights_one': '{count} ночь',
  'plural.nights_few': '{count} ночи',
  'plural.nights_many': '{count} ночей',
  'plural.nights_other': '{count} ночей',
  'plural.weekdayNights_one': '{count} будний день',
  'plural.weekdayNights_few': '{count} будних дня',
  'plural.weekdayNights_many': '{count} будних дней',
  'plural.weekdayNights_other': '{count} будних дней',
  'plural.weekendNights_one': '{count} выходной день',
  'plural.weekendNights_few': '{count} выходных дня',
  'plural.weekendNights_many': '{count} выходных дней',
  'plural.weekendNights_other': '{count} выходных дней',
  'plural.guests_one': '{count} гость',
  'plural.guests_few': '{count} гостя',
  'plural.guests_many': '{count} гостей',
  'plural.guests_other': '{count} гостей',

  // ----------------------------------------------------------- tab bar --
  'tabs.villas': 'Виллы',
  'tabs.commissions': 'Комиссии',

  // -------------------------------------------------------- onboarding --
  'onboarding.title': 'Завершите регистрацию в чате',
  'onboarding.bodyNamed':
    '{name}, ваш аккаунт ещё не настроен. Отправьте боту /start и ответьте на несколько коротких вопросов — язык, номер телефона, ваше имя и как вы будете пользоваться Oikoz.',
  'onboarding.body':
    'Ваш аккаунт ещё не настроен. Отправьте боту /start и ответьте на несколько коротких вопросов — язык, номер телефона, ваше имя и как вы будете пользоваться Oikoz.',
  'onboarding.thenOpen': 'После этого нажмите «Открыть приложение» в чате — и вы окажетесь сразу здесь.',
  'onboarding.retry': 'Готово — проверить ещё раз',

  // -------------------------------------------------------------- home --
  'home.roleOwnerMakler': 'Владелец и маклер',
  'home.roleOwner': 'Владелец',
  'home.roleMakler': 'Маклер',
  'home.roleClient': 'Клиент',
  'home.addVillaAria': 'Добавить виллу',
  'home.myVillas': 'Мои виллы',
  'home.assignedVillas': 'Виллы, назначенные мне',
  'home.noVillasTitle': 'Вилл пока нет',
  'home.noVillasBody': 'Добавьте первую виллу, укажите тарифы и начните принимать брони.',
  'home.addVilla': 'Добавить виллу',
  'home.noAssignedTitle': 'Вам пока не назначили виллы',
  'home.noAssignedBody': 'Сообщите владельцу свой номер Oikoz, и он сможет вас добавить:',
  'home.clientTitle': 'Эта страница пока не готова',
  'home.clientBody': 'Здесь пока нечего показать. Мы напишем вам в чат, когда появится.',
  'home.noLocation': 'Расположение не указано',
  'home.rateWeekday': 'Пн–Пт',
  'home.rateWeekend': 'Сб–Вс',
  'home.rateCommission': 'Комиссия',

  // ---------------------------------------------------------- calendar --
  'calendar.prevMonth': 'Предыдущий месяц',
  'calendar.nextMonth': 'Следующий месяц',
  'calendar.legendAvailable': 'Свободно',
  'calendar.legendBooked': 'Занято',
  'calendar.legendBlocked': 'Закрыто',
  'calendar.legendPast': 'Прошедшие',
  'calendar.dayBooked': '{date} — забронировал(а) {name}',
  'calendar.dayBlocked': '{date} — закрыто',
  'calendar.dayAvailable': '{date} — свободно',
  'calendar.dayUnavailable': '{date} — недоступно',

  // ----------------------------------------------------- villa calendar --
  'villa.setupAria': 'Настройки виллы',
  'villa.nightsBooked': 'Ночей забронировано',
  'villa.yourPayout': 'Ваша выплата',
  'villa.yourCommission': 'Ваша комиссия',
  'villa.notBooked': 'Свободно',
  'villa.blockDates': 'Закрыть эти даты',
  'villa.logBooking': 'Записать бронь',
  'villa.newBooking': 'Новая бронь',
  'villa.upcoming': 'Ближайшие',
  'villa.nothingBookedTitle': 'Броней пока нет',
  'villa.nothingBookedOwner': 'Брони, созданные вашими маклерами, появятся здесь.',
  'villa.nothingBookedMakler': 'Нажмите на свободный день, чтобы добавить бронь.',
  'villa.depositPending': 'Залог не внесён',
  'villa.rowPayout': 'выплата {amount}',
  'villa.rowYou': 'вам {amount}',
  'villa.rowOtherMakler': 'другой маклер',
  'villa.weekendRate': 'Тариф выходного дня',
  'villa.weekdayRate': 'Тариф буднего дня',
  'villa.deposit': 'Залог',
  'villa.bookThisDate': 'Забронировать эту дату',
  'villa.blockFrom': 'С {date}',
  'villa.blockUntilLabel': 'Закрыто до (этот день остаётся свободным)',
  'villa.blockReasonLabel': 'Причина',
  'villa.blocking': 'Закрываем…',
  'villa.blockSubmit': 'Закрыть даты',
  'villa.notAvailable': 'Недоступно',
  'villa.unblocking': 'Открываем…',
  'villa.unblock': 'Открыть',
  'villa.unblockConfirm': 'Снова открыть эти даты?',
  'villa.closedByOwner': 'Эти даты закрыты владельцем.',
  'blockReason.owner_use': 'Для владельца',
  'blockReason.maintenance': 'Обслуживание',
  'blockReason.off_market': 'Снято с продажи',

  // ------------------------------------------------------- villa setup --
  'setup.titleNew': 'Новая вилла',
  'setup.title': 'Настройки виллы',
  'setup.ownerOnly': 'Менять тарифы и комиссию может только владелец виллы.',
  'setup.nameRequired': 'Укажите название виллы.',
  'setup.referenceRequired': 'Введите номер Oikoz маклера.',
  'setup.removeMaklerConfirm': 'Убрать {name} с этой виллы?',
  'setup.deleteVillaConfirm': 'Удалить эту виллу и все её брони? Отменить это будет нельзя.',
  'setup.nameLabel': 'Название виллы',
  'setup.namePlaceholder': 'Chorvoq House',
  'setup.locationLabel': 'Расположение',
  'setup.locationPlaceholder': 'Чорвок, Ташкентская область',
  'setup.currencyLabel': 'Валюта',
  'setup.capacityLabel': 'Вместимость',
  'setup.currencyHint': 'Валюта задаётся для каждой виллы отдельно — можно совмещать USD и UZS.',
  'setup.ratesTitle': 'Тарифы за ночь',
  'setup.weekdayLabel': 'Будни (Пн–Пт)',
  'setup.weekendLabel': 'Выходные (Сб–Вс)',
  'setup.ratesHint': 'Используются для подстановки суммы брони. Маклер всё равно может изменить её вручную.',
  'setup.depositLabel': 'Залог по умолчанию',
  'setup.depositHint': 'Подставляется в каждую бронь, в отдельной броне сумму можно увеличить. Минимум {min}.',
  'setup.commissionTitle': 'Комиссия',
  'setup.commissionLabel': 'Комиссия маклера, %',
  'setup.platformFeeLabel': 'Комиссия платформы, %',
  'setup.commissionHint':
    'Изменения затронут только новые брони — в существующих сохранится ставка, с которой они были созданы.',
  'setup.maklersTitle': 'Маклеры',
  'setup.noMaklers': 'Маклеры пока не добавлены.',
  'setup.addMaklerLabel': 'Добавить маклера по номеру Oikoz',
  'setup.linkMakler': 'Добавить маклера',
  'setup.addMaklerHint':
    'Он должен пройти регистрацию в боте как маклер. Его номер — например oikoz_id0001 — показан у него на главном экране.',
  'setup.createVilla': 'Создать виллу',
  'setup.deleteVilla': 'Удалить виллу',

  // ----------------------------------------------------------- booking --
  'booking.titleNew': 'Новая бронь',
  'booking.title': 'Бронь',
  'booking.cancelledNotice': 'Эта бронь отменена. Даты снова свободны.',
  'booking.ownerReadOnly': 'Вы можете посмотреть и отменить эту бронь. Редактировать детали могут только маклеры.',
  'booking.clientNameLabel': 'Имя клиента',
  'booking.clientNamePlaceholder': 'Имя и фамилия',
  'booking.phoneLabel': 'Телефон',
  'booking.phonePlaceholder': '+998 90 000 00 00',
  'booking.checkIn': 'Заезд',
  'booking.checkOut': 'Выезд',
  'booking.clientTypeLabel': 'Тип клиента',
  'booking.clientTypeNone': 'Не указан',
  'booking.commissionTitle': 'Комиссия',
  'booking.creditedFor': '{reference} · комиссия по этой брони',
  'booking.creditLabel': 'Указать маклера (необязательно)',
  'booking.creditChecking': 'Проверяем…',
  'booking.creditSubmit': 'Указать этого маклера',
  'booking.creditHint':
    'Оставьте пустым, если клиента привели не через маклера — тогда вся выплата ваша, за вычетом комиссии платформы.',
  'booking.priceTitle': 'Цена',
  'booking.modePercentage': 'Процент комиссии',
  'booking.modeOwnerNet': 'Чистыми владельцу',
  'booking.ownerNetLabel': 'Чистыми владельцу ({currency})',
  'booking.ownerNetHint':
    'Сумма, обещанная владельцу, независимо от вашей цены. Подставлена по тарифам виллы за эти ночи.',
  'booking.chargedLabel': 'К оплате клиентом ({currency})',
  'booking.totalLabel': 'Итого ({currency})',
  'booking.resetTo': 'Вернуть {amount}',
  'booking.chargedHint':
    'Сколько платит клиент. Всё сверх суммы владельца, за вычетом комиссии платформы, ваше.',
  'booking.totalHint': 'Подставлено по тарифам виллы — измените для скидок или доплат.',
  'booking.yourCommission': 'Ваша комиссия: {amount}',
  'booking.afterPlatformFee': '(после комиссии платформы {amount})',
  'booking.depositLabel': 'Залог ({currency})',
  'booking.depositHint':
    'Удерживается на случай ущерба и возвращается при выезде — в раздел ниже не входит. Минимум {min}.',
  'booking.depositPaidQuestion': 'Клиент внёс залог?',
  'booking.depositPaidYes': '✓ Внесён',
  'booking.depositPaidNo': 'Не внесён',
  'booking.splitTitle': 'Распределение',
  'booking.splitTotal': 'Итого',
  'booking.splitPlatformFee': 'Комиссия платформы ({rate})',
  'booking.splitNoMakler': 'Комиссия маклера (не указан)',
  'booking.splitSpread': 'Комиссия маклера (разница)',
  'booking.splitCommission': 'Комиссия маклера ({rate})',
  'booking.splitOwnerPayout': 'Выплата владельцу',
  'booking.splitDeposit': 'Залог (хранится отдельно)',
  'booking.statusConfirmed': 'Подтверждена',
  'booking.statusCancelled': 'Отменена',
  'booking.commissionBadge': 'Комиссия: {status}',
  'booking.notesLabel': 'Заметки',
  'booking.notesPlaceholder': 'Время заезда, дополнительно, залог…',
  'booking.create': 'Создать бронь',
  'booking.cancel': 'Отменить бронь',
  'booking.reopen': 'Восстановить бронь',
  'booking.cancelConfirm': 'Отменить эту бронь? Её дни снова станут свободными.',
  'booking.reopenConfirm': 'Восстановить бронь и снова закрыть эти дни?',
  'booking.nightsSubtotal': '{nights} × {rate}',
  'clientType.family': 'Семья',
  'clientType.friends_mixed': 'Друзья (смешанная компания)',
  'clientType.friends_men': 'Друзья (мужская компания)',
  'clientType.friends_women': 'Друзья (женская компания)',
  'clientType.couple': 'Пара',
  'clientType.business': 'Бизнес',
  'clientType.other': 'Другое',

  // ------------------------------------------------- booking validation --
  'error.clientNameRequired': 'Введите имя клиента.',
  'error.datesRequired': 'Укажите обе даты.',
  'error.checkOutAfterCheckIn': 'Дата выезда должна быть позже даты заезда.',
  'error.depositTooLow': 'Залог не может быть меньше {min}.',
  'error.ownerNetRequired': 'Укажите сумму чистыми для владельца.',
  'error.totalBelowOwnerNet': 'Итоговая сумма не может быть меньше суммы владельца.',
  'error.notAMakler': 'Этот номер не принадлежит зарегистрированному маклеру.',
  'error.belongsToMakler': 'Эта бронь принадлежит маклеру — вы можете отменить её или отметить залог внесённым.',
  'error.datesOverlap': 'Эти даты пересекаются с другой бронью этой виллы.',
  'error.ownersMayOnlyCancel': 'Владелец может только отменить бронь, но не редактировать её.',
  'error.ownerSettlesCommission': 'Отмечать комиссию выплаченной может только владелец виллы.',
  'error.languageSaveFailed': 'Не удалось сохранить язык. Попробуйте ещё раз.',

  // ------------------------------------------------------- commissions --
  'commissions.title': 'Комиссии',
  'commissions.subtitleOwner': 'Долг перед вашими маклерами',
  'commissions.subtitleMakler': 'Ваш заработок',
  'commissions.asOwner': 'Как владелец',
  'commissions.asMakler': 'Как маклер',
  'commissions.tabCommission': 'Комиссия',
  'commissions.tabDeposits': 'Залоги в ожидании',
  'commissions.maklerEmptyTitle': 'Комиссий пока нет',
  'commissions.maklerEmptyBody': 'Созданные вами брони появятся здесь вместе с вашим заработком.',
  'commissions.statUnpaid': 'Не выплачено · {currency}',
  'commissions.statPaid': 'Выплачено · {currency}',
  'commissions.bookings': 'Брони',
  'commissions.ownerEmptyTitle': 'Задолженности пока нет',
  'commissions.ownerEmptyBody': 'Как только ваши маклеры оформят брони, здесь появится сумма долга.',
  'commissions.owedPerMakler': 'Долг по маклерам',
  'commissions.alreadySettled': '{amount} уже выплачено',
  'commissions.nothingSettled': 'Пока ничего не выплачено',
  'commissions.openCommission': 'Открытые комиссии',
  'commissions.allSettledTitle': 'Всё выплачено',
  'commissions.allSettledBody': 'Все комиссии по вашим виллам отмечены выплаченными.',
  'commissions.markPaid': 'Отметить выплаченной',
  'commissions.settled': 'Выплаченные',
  'commissions.maklerFallback': 'Маклер',
  'commissions.noDepositsTitle': 'Залогов в ожидании нет',
  'commissions.noDepositsBody': 'По всем подтверждённым броням залог получен.',
  'commissions.statOutstanding': 'Ожидается · {currency}',
  'commissions.awaitingDeposit': 'Ожидают залога',
  'commissions.amountDue': '{amount} к оплате',
  'commissions.markReceived': 'Отметить полученным',

  // --------------------------------------------------------- breakdown --
  'breakdown.title': 'Сводка',
  'breakdown.allVillas': 'Все мои виллы',
  'breakdown.thisVilla': 'Эта вилла',
  'breakdown.unitWeek': 'Неделя',
  'breakdown.unitMonth': 'Месяц',
  'breakdown.unitYear': 'Год',
  'breakdown.prevPeriod': 'Предыдущий период',
  'breakdown.nextPeriod': 'Следующий период',
  'breakdown.nightsBooked': 'Ночей забронировано',
  'breakdown.bookings': 'Броней',
  'breakdown.emptyTitle': 'В этом периоде пусто',
  'breakdown.emptyWeek': 'На этой неделе заездов не было.',
  'breakdown.emptyMonth': 'В этом месяце заездов не было.',
  'breakdown.emptyYear': 'В этом году заездов не было.',
  'breakdown.payout': 'Выплата',
  'breakdown.gross': 'Валовая выручка',
  'breakdown.included': 'Учтённые брони',
  // ------------------------------------------------- retroactive logging --
  'booking.pastDateNotice':
    'Если на эту дату была бронь, её можно внести задним числом — она попадёт в вашу выручку.',
  'booking.untitled': 'Бронь',
  'booking.depositHintSimple':
    'Удерживается на случай ущерба и возвращается при выезде — отдельно от суммы выше. Минимум {min}.',
  'calendar.dayBookedNoName': '{date} — занято',
  'calendar.dayLoggable': '{date} — прошедший день, нажмите, чтобы внести бронь',
  'plural.bookings_one': '{count} бронь',
  'plural.bookings_few': '{count} брони',
  'plural.bookings_many': '{count} броней',
  'plural.bookings_other': '{count} броней',

  // ------------------------------------------------------ villa removal --
  'setup.removeTitle': 'Удаление виллы',
  'setup.deleteHint': 'У этой виллы нет броней, поэтому её можно удалить безвозвратно.',
  'setup.archiveVilla': 'Архивировать виллу',
  'setup.archiveHint':
    'В истории этой виллы {bookings}. Архивация уберёт её из «Моих вилл», но все брони, выплаты и комиссии останутся без изменений.',
  'setup.archiveConfirm': 'Архивировать виллу? Она исчезнет из «Моих вилл», но вся история сохранится.',
  'setup.unarchiveVilla': 'Вернуть виллу',
  'setup.archivedNotice': 'Вилла в архиве. Она не показывается в «Моих виллах», но её выручка по-прежнему учитывается.',
  'home.archivedToggle': 'Виллы в архиве ({count})',
  'home.unarchive': 'Вернуть',
}

const uz: Record<StringKey, string> = {
  // ------------------------------------------------------------ common --
  'common.back': 'Orqaga',
  'common.close': 'Yopish',
  'common.remove': 'Olib tashlash',
  'common.loading': 'Yuklanmoqda…',
  'common.signingIn': 'Kirilmoqda…',
  'common.signInFailed': 'Kirib bo‘lmadi.',
  'common.errorTitle': 'Nimadir xato ketdi',
  'common.tryAgain': 'Qayta urinish',
  'common.saving': 'Saqlanmoqda…',
  'common.saveChanges': 'O‘zgarishlarni saqlash',
  'common.language': 'Til',
  'common.paid': 'to‘langan',
  'common.unpaid': 'to‘lanmagan',

  // ------------------------------------------------------------- plurals --
  'plural.nights_one': '{count} kecha',
  'plural.nights_few': '{count} kecha',
  'plural.nights_many': '{count} kecha',
  'plural.nights_other': '{count} kecha',
  'plural.weekdayNights_one': '{count} ish kuni kechasi',
  'plural.weekdayNights_few': '{count} ish kuni kechasi',
  'plural.weekdayNights_many': '{count} ish kuni kechasi',
  'plural.weekdayNights_other': '{count} ish kuni kechasi',
  'plural.weekendNights_one': '{count} dam olish kuni kechasi',
  'plural.weekendNights_few': '{count} dam olish kuni kechasi',
  'plural.weekendNights_many': '{count} dam olish kuni kechasi',
  'plural.weekendNights_other': '{count} dam olish kuni kechasi',
  'plural.guests_one': '{count} mehmon',
  'plural.guests_few': '{count} mehmon',
  'plural.guests_many': '{count} mehmon',
  'plural.guests_other': '{count} mehmon',

  // ----------------------------------------------------------- tab bar --
  'tabs.villas': 'Villalar',
  'tabs.commissions': 'Komissiyalar',

  // -------------------------------------------------------- onboarding --
  'onboarding.title': 'Ro‘yxatdan o‘tishni chatda yakunlang',
  'onboarding.bodyNamed':
    '{name}, hisobingiz hali sozlanmagan. Botga /start yuboring va bir nechta qisqa savolga javob bering — til, telefon raqami, ismingiz va Oikoz’dan qanday foydalanishingiz.',
  'onboarding.body':
    'Hisobingiz hali sozlanmagan. Botga /start yuboring va bir nechta qisqa savolga javob bering — til, telefon raqami, ismingiz va Oikoz’dan qanday foydalanishingiz.',
  'onboarding.thenOpen': 'Shundan so‘ng chatdagi «Ilovani ochish» tugmasini bosing — to‘g‘ridan-to‘g‘ri shu yerga tushasiz.',
  'onboarding.retry': 'Bajardim — qayta tekshirish',

  // -------------------------------------------------------------- home --
  'home.roleOwnerMakler': 'Ega va makler',
  'home.roleOwner': 'Ega',
  'home.roleMakler': 'Makler',
  'home.roleClient': 'Mijoz',
  'home.addVillaAria': 'Villa qo‘shish',
  'home.myVillas': 'Mening villalarim',
  'home.assignedVillas': 'Menga biriktirilgan villalar',
  'home.noVillasTitle': 'Hozircha villa yo‘q',
  'home.noVillasBody': 'Birinchi villangizni qo‘shing, narxlarini belgilang va bron qabul qilishni boshlang.',
  'home.addVilla': 'Villa qo‘shish',
  'home.noAssignedTitle': 'Hozircha villa biriktirilmagan',
  'home.noAssignedBody': 'Oikoz raqamingizni egaga bering — u sizni qo‘sha oladi:',
  'home.clientTitle': 'Bu sahifa hali tayyor emas',
  'home.clientBody': 'Hozircha bu yerda ko‘rsatadigan narsa yo‘q. Tayyor bo‘lganda chatda xabar beramiz.',
  'home.noLocation': 'Manzil ko‘rsatilmagan',
  'home.rateWeekday': 'Du–Ju',
  'home.rateWeekend': 'Sh–Ya',
  'home.rateCommission': 'Komissiya',

  // ---------------------------------------------------------- calendar --
  'calendar.prevMonth': 'Oldingi oy',
  'calendar.nextMonth': 'Keyingi oy',
  'calendar.legendAvailable': 'Bo‘sh',
  'calendar.legendBooked': 'Band',
  'calendar.legendBlocked': 'Yopiq',
  'calendar.legendPast': 'O‘tgan',
  'calendar.dayBooked': '{date} — {name} bron qilgan',
  'calendar.dayBlocked': '{date} — yopiq',
  'calendar.dayAvailable': '{date} — bo‘sh',
  'calendar.dayUnavailable': '{date} — mavjud emas',

  // ----------------------------------------------------- villa calendar --
  'villa.setupAria': 'Villa sozlamalari',
  'villa.nightsBooked': 'Bron qilingan kechalar',
  'villa.yourPayout': 'Sizning to‘lovingiz',
  'villa.yourCommission': 'Sizning komissiyangiz',
  'villa.notBooked': 'Bo‘sh',
  'villa.blockDates': 'Bu sanalarni yopish',
  'villa.logBooking': 'Bronni qayd etish',
  'villa.newBooking': 'Yangi bron',
  'villa.upcoming': 'Yaqin kunlarda',
  'villa.nothingBookedTitle': 'Hozircha bron yo‘q',
  'villa.nothingBookedOwner': 'Maklerlaringiz yaratgan bronlar shu yerda ko‘rinadi.',
  'villa.nothingBookedMakler': 'Bron qo‘shish uchun bo‘sh kunga bosing.',
  'villa.depositPending': 'Garov kutilmoqda',
  'villa.rowPayout': 'to‘lov {amount}',
  'villa.rowYou': 'sizga {amount}',
  'villa.rowOtherMakler': 'boshqa makler',
  'villa.weekendRate': 'Dam olish kuni narxi',
  'villa.weekdayRate': 'Ish kuni narxi',
  'villa.deposit': 'Garov',
  'villa.bookThisDate': 'Shu sanani bron qilish',
  'villa.blockFrom': '{date} dan',
  'villa.blockUntilLabel': 'Shu sanagacha yopiq (bu kun bo‘sh qoladi)',
  'villa.blockReasonLabel': 'Sabab',
  'villa.blocking': 'Yopilmoqda…',
  'villa.blockSubmit': 'Sanalarni yopish',
  'villa.notAvailable': 'Mavjud emas',
  'villa.unblocking': 'Ochilmoqda…',
  'villa.unblock': 'Ochish',
  'villa.unblockConfirm': 'Bu sanalarni qayta ochamizmi?',
  'villa.closedByOwner': 'Bu sanalar ega tomonidan yopilgan.',
  'blockReason.owner_use': 'Ega foydalanadi',
  'blockReason.maintenance': 'Ta’mirlash',
  'blockReason.off_market': 'Sotuvdan olingan',

  // ------------------------------------------------------- villa setup --
  'setup.titleNew': 'Yangi villa',
  'setup.title': 'Villa sozlamalari',
  'setup.ownerOnly': 'Narx va komissiyani faqat villa egasi o‘zgartira oladi.',
  'setup.nameRequired': 'Villaga nom bering.',
  'setup.referenceRequired': 'Maklerning Oikoz raqamini kiriting.',
  'setup.removeMaklerConfirm': '{name} shu villadan olib tashlansinmi?',
  'setup.deleteVillaConfirm': 'Bu villa va uning barcha bronlari o‘chirilsinmi? Buni ortga qaytarib bo‘lmaydi.',
  'setup.nameLabel': 'Villa nomi',
  'setup.namePlaceholder': 'Chorvoq House',
  'setup.locationLabel': 'Manzil',
  'setup.locationPlaceholder': 'Chorvoq, Toshkent viloyati',
  'setup.currencyLabel': 'Valyuta',
  'setup.capacityLabel': 'Sig‘imi',
  'setup.currencyHint': 'Valyuta har bir villa uchun alohida belgilanadi — USD va UZS’ni aralashtirish mumkin.',
  'setup.ratesTitle': 'Bir kechalik narxlar',
  'setup.weekdayLabel': 'Ish kunlari (Du–Ju)',
  'setup.weekendLabel': 'Dam olish kunlari (Sh–Ya)',
  'setup.ratesHint': 'Bron summasini oldindan to‘ldirish uchun ishlatiladi. Makler summani qo‘lda o‘zgartira oladi.',
  'setup.depositLabel': 'Standart garov',
  'setup.depositHint': 'Har bir bronga qo‘yiladi va alohida bronda oshirilishi mumkin. Eng kami {min}.',
  'setup.commissionTitle': 'Komissiya',
  'setup.commissionLabel': 'Makler komissiyasi, %',
  'setup.platformFeeLabel': 'Platforma to‘lovi, %',
  'setup.commissionHint':
    'O‘zgartirish faqat yangi bronlarga ta’sir qiladi — mavjud bronlar yaratilgan paytdagi stavkani saqlab qoladi.',
  'setup.maklersTitle': 'Maklerlar',
  'setup.noMaklers': 'Hozircha makler biriktirilmagan.',
  'setup.addMaklerLabel': 'Oikoz raqami bo‘yicha makler qo‘shish',
  'setup.linkMakler': 'Maklerni qo‘shish',
  'setup.addMaklerHint':
    'U botda makler sifatida ro‘yxatdan o‘tgan bo‘lishi kerak. Uning raqami — masalan oikoz_id0001 — o‘z bosh ekranida ko‘rinadi.',
  'setup.createVilla': 'Villa yaratish',
  'setup.deleteVilla': 'Villani o‘chirish',

  // ----------------------------------------------------------- booking --
  'booking.titleNew': 'Yangi bron',
  'booking.title': 'Bron',
  'booking.cancelledNotice': 'Bu bron bekor qilingan. Uning kunlari yana bo‘sh.',
  'booking.ownerReadOnly': 'Siz bu bronni ko‘rishingiz va bekor qilishingiz mumkin. Tafsilotlarni faqat maklerlar tahrirlaydi.',
  'booking.clientNameLabel': 'Mijoz ismi',
  'booking.clientNamePlaceholder': 'Ism va familiya',
  'booking.phoneLabel': 'Telefon',
  'booking.phonePlaceholder': '+998 90 000 00 00',
  'booking.checkIn': 'Kelish',
  'booking.checkOut': 'Ketish',
  'booking.clientTypeLabel': 'Mijoz turi',
  'booking.clientTypeNone': 'Ko‘rsatilmagan',
  'booking.commissionTitle': 'Komissiya',
  'booking.creditedFor': '{reference} · shu bron uchun komissiya',
  'booking.creditLabel': 'Maklerni ko‘rsatish (ixtiyoriy)',
  'booking.creditChecking': 'Tekshirilmoqda…',
  'booking.creditSubmit': 'Shu maklerni ko‘rsatish',
  'booking.creditHint':
    'Agar mijozni makler olib kelmagan bo‘lsa, bo‘sh qoldiring — platforma to‘lovidan tashqari butun to‘lov sizniki.',
  'booking.priceTitle': 'Narx',
  'booking.modePercentage': 'Komissiya foizi',
  'booking.modeOwnerNet': 'Egaga sof summa',
  'booking.ownerNetLabel': 'Egaga sof summa ({currency})',
  'booking.ownerNetHint':
    'Qancha olishingizdan qat’i nazar, egaga va’da qilingan summa. Shu kechalar uchun villa narxlaridan olindi.',
  'booking.chargedLabel': 'Mijozdan olinadi ({currency})',
  'booking.totalLabel': 'Jami narx ({currency})',
  'booking.resetTo': '{amount} ga qaytarish',
  'booking.chargedHint':
    'Mijoz haqiqatda to‘laydigan summa. Eganing sof summasidan ortiqchasi, platforma to‘lovi chegirilgach, sizniki.',
  'booking.totalHint': 'Villa narxlaridan olindi — chegirma yoki qo‘shimchalar uchun o‘zgartiring.',
  'booking.yourCommission': 'Sizning komissiyangiz: {amount}',
  'booking.afterPlatformFee': '({amount} platforma to‘lovidan keyin)',
  'booking.depositLabel': 'Garov ({currency})',
  'booking.depositHint':
    'Zarar uchun ushlab turiladi va ketishda qaytariladi — quyidagi taqsimotga kirmaydi. Eng kami {min}.',
  'booking.depositPaidQuestion': 'Mijoz garovni to‘ladimi?',
  'booking.depositPaidYes': '✓ To‘langan',
  'booking.depositPaidNo': 'To‘lanmagan',
  'booking.splitTitle': 'Taqsimot',
  'booking.splitTotal': 'Jami',
  'booking.splitPlatformFee': 'Platforma to‘lovi ({rate})',
  'booking.splitNoMakler': 'Makler komissiyasi (ko‘rsatilmagan)',
  'booking.splitSpread': 'Makler komissiyasi (farq)',
  'booking.splitCommission': 'Makler komissiyasi ({rate})',
  'booking.splitOwnerPayout': 'Egaga to‘lov',
  'booking.splitDeposit': 'Garov (alohida saqlanadi)',
  'booking.statusConfirmed': 'Tasdiqlangan',
  'booking.statusCancelled': 'Bekor qilingan',
  'booking.commissionBadge': 'Komissiya: {status}',
  'booking.notesLabel': 'Izohlar',
  'booking.notesPlaceholder': 'Kelish vaqti, qo‘shimchalar, garov…',
  'booking.create': 'Bron yaratish',
  'booking.cancel': 'Bronni bekor qilish',
  'booking.reopen': 'Bronni tiklash',
  'booking.cancelConfirm': 'Bu bron bekor qilinsinmi? Uning kunlari yana bo‘sh bo‘ladi.',
  'booking.reopenConfirm': 'Bron tiklanib, o‘sha kunlar yana yopilsinmi?',
  'booking.nightsSubtotal': '{nights} × {rate}',
  'clientType.family': 'Oila',
  'clientType.friends_mixed': 'Do‘stlar (aralash)',
  'clientType.friends_men': 'Do‘stlar (erkaklar)',
  'clientType.friends_women': 'Do‘stlar (ayollar)',
  'clientType.couple': 'Juftlik',
  'clientType.business': 'Biznes',
  'clientType.other': 'Boshqa',

  // ------------------------------------------------- booking validation --
  'error.clientNameRequired': 'Mijoz ismini kiriting.',
  'error.datesRequired': 'Ikkala sanani ham tanlang.',
  'error.checkOutAfterCheckIn': 'Ketish sanasi kelish sanasidan keyin bo‘lishi kerak.',
  'error.depositTooLow': 'Garov {min} dan kam bo‘lishi mumkin emas.',
  'error.ownerNetRequired': 'Egaga tegishli sof summani kiriting.',
  'error.totalBelowOwnerNet': 'Jami narx eganing sof summasidan kam bo‘lmasligi kerak.',
  'error.notAMakler': 'Bu raqam ro‘yxatdan o‘tgan maklerga tegishli emas.',
  'error.belongsToMakler': 'Bu bron maklerga tegishli — uni bekor qilishingiz yoki garovni to‘langan deb belgilashingiz mumkin.',
  'error.datesOverlap': 'Bu sanalar shu villaning boshqa broni bilan kesishadi.',
  'error.ownersMayOnlyCancel': 'Ega bronni faqat bekor qila oladi, tahrirlay olmaydi.',
  'error.ownerSettlesCommission': 'Komissiyani to‘langan deb belgilashni faqat villa egasi qila oladi.',
  'error.languageSaveFailed': 'Tilni saqlab bo‘lmadi. Qayta urinib ko‘ring.',

  // ------------------------------------------------------- commissions --
  'commissions.title': 'Komissiyalar',
  'commissions.subtitleOwner': 'Maklerlaringizga qarz',
  'commissions.subtitleMakler': 'Sizning daromadingiz',
  'commissions.asOwner': 'Ega sifatida',
  'commissions.asMakler': 'Makler sifatida',
  'commissions.tabCommission': 'Komissiya',
  'commissions.tabDeposits': 'Kutilayotgan garovlar',
  'commissions.maklerEmptyTitle': 'Hozircha komissiya yo‘q',
  'commissions.maklerEmptyBody': 'Siz yaratgan bronlar daromadingiz bilan birga shu yerda ko‘rinadi.',
  'commissions.statUnpaid': 'To‘lanmagan · {currency}',
  'commissions.statPaid': 'To‘langan · {currency}',
  'commissions.bookings': 'Bronlar',
  'commissions.ownerEmptyTitle': 'Hozircha qarz yo‘q',
  'commissions.ownerEmptyBody': 'Maklerlaringiz bron qila boshlagach, ularga qarzingiz shu yerda ko‘rinadi.',
  'commissions.owedPerMakler': 'Maklerlar bo‘yicha qarz',
  'commissions.alreadySettled': '{amount} allaqachon to‘langan',
  'commissions.nothingSettled': 'Hozircha hech narsa to‘lanmagan',
  'commissions.openCommission': 'Ochiq komissiyalar',
  'commissions.allSettledTitle': 'Hammasi to‘langan',
  'commissions.allSettledBody': 'Villalaringiz bo‘yicha barcha komissiyalar to‘langan deb belgilangan.',
  'commissions.markPaid': 'To‘langan deb belgilash',
  'commissions.settled': 'To‘langanlar',
  'commissions.maklerFallback': 'Makler',
  'commissions.noDepositsTitle': 'Kutilayotgan garov yo‘q',
  'commissions.noDepositsBody': 'Barcha tasdiqlangan bronlar bo‘yicha garov olingan.',
  'commissions.statOutstanding': 'Kutilmoqda · {currency}',
  'commissions.awaitingDeposit': 'Garov kutilmoqda',
  'commissions.amountDue': '{amount} to‘lanishi kerak',
  'commissions.markReceived': 'Olindi deb belgilash',

  // --------------------------------------------------------- breakdown --
  'breakdown.title': 'Hisobot',
  'breakdown.allVillas': 'Barcha villalarim',
  'breakdown.thisVilla': 'Shu villa',
  'breakdown.unitWeek': 'Hafta',
  'breakdown.unitMonth': 'Oy',
  'breakdown.unitYear': 'Yil',
  'breakdown.prevPeriod': 'Oldingi davr',
  'breakdown.nextPeriod': 'Keyingi davr',
  'breakdown.nightsBooked': 'Bron qilingan kechalar',
  'breakdown.bookings': 'Bronlar',
  'breakdown.emptyTitle': 'Bu davrda hech narsa yo‘q',
  'breakdown.emptyWeek': 'Bu hafta hech kim kelmagan.',
  'breakdown.emptyMonth': 'Bu oyda hech kim kelmagan.',
  'breakdown.emptyYear': 'Bu yilda hech kim kelmagan.',
  'breakdown.payout': 'To‘lov',
  'breakdown.gross': 'Yalpi tushum',
  'breakdown.included': 'Hisobga olingan bronlar',
  // ------------------------------------------------- retroactive logging --
  'booking.pastDateNotice':
    'Agar bu sanada bron bo‘lgan bo‘lsa, uni keyin ham qayd etishingiz mumkin — u tushumingizga qo‘shiladi.',
  'booking.untitled': 'Bron',
  'booking.depositHintSimple':
    'Zarar uchun ushlab turiladi va ketishda qaytariladi — yuqoridagi summadan alohida. Eng kami {min}.',
  'calendar.dayBookedNoName': '{date} — band',
  'calendar.dayLoggable': '{date} — o‘tgan kun, bron qayd etish uchun bosing',
  'plural.bookings_one': '{count} bron',
  'plural.bookings_few': '{count} bron',
  'plural.bookings_many': '{count} bron',
  'plural.bookings_other': '{count} bron',

  // ------------------------------------------------------ villa removal --
  'setup.removeTitle': 'Villani olib tashlash',
  'setup.deleteHint': 'Bu villada bron yo‘q, shuning uchun uni butunlay o‘chirish mumkin.',
  'setup.archiveVilla': 'Villani arxivlash',
  'setup.archiveHint':
    'Bu villa tarixida {bookings} bor. Arxivlash uni «Mening villalarim»dan yashiradi, barcha bron, to‘lov va komissiyalar esa o‘zgarishsiz qoladi.',
  'setup.archiveConfirm': 'Villa arxivlansinmi? U «Mening villalarim»dan chiqadi, lekin butun tarixi saqlanadi.',
  'setup.unarchiveVilla': 'Villani tiklash',
  'setup.archivedNotice': 'Villa arxivda. U «Mening villalarim»da ko‘rinmaydi, tushumi esa hisobga olinaveradi.',
  'home.archivedToggle': 'Arxivdagi villalar ({count})',
  'home.unarchive': 'Tiklash',
}

export const STRINGS: Record<Lang, Record<StringKey, string>> = { en, ru, uz }

export type Vars = Record<string, string | number>

function interpolate(template: string, vars?: Vars): string {
  if (!vars) return template
  return template.replace(/\{(\w+)\}/g, (match, key: string) =>
    key in vars ? String(vars[key]) : match,
  )
}

/** Falls back to English for a key a translator has not filled in yet. */
export function translate(lang: Lang, key: StringKey, vars?: Vars): string {
  return interpolate(STRINGS[lang][key] ?? en[key] ?? key, vars)
}

/** Bases that have `_one` / `_few` / `_many` / `_other` variants in the table. */
export type PluralBase = 'nights' | 'weekdayNights' | 'weekendNights' | 'guests' | 'bookings'

export function plural(lang: Lang, base: PluralBase, count: number, vars?: Vars): string {
  const key = `plural.${base}_${pluralCategory(lang, count)}` as StringKey
  return translate(lang, key, { count, ...vars })
}
