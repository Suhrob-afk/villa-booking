// ============================================================================
// telegram-bot-webhook — the registration conversation that runs BEFORE the
// Mini App opens.
//
//   /start -> language -> phone -> full name -> identity -> "Open App" button
//
// Conversation position lives in public.bot_onboarding_state, one row per
// telegram_id. On the final step the profile is upserted into public.users
// and the user gets their Oikoz reference back.
//
// This function never touches telegram-auth: a user who finishes here simply
// already exists by the time the Mini App calls it.
//
// It also receives the contact a visitor shares from the public booking page
// (Telegram.WebApp.requestContact sends it to the bot as an ordinary message)
// and saves the phone on their users row -- see savePublicContact().
//
// Secrets:
//   TELEGRAM_BOT_TOKEN       — same bot as the Mini App
//   MINI_APP_URL             — https URL the "Open App" button opens
//   TELEGRAM_WEBHOOK_SECRET  — REQUIRED. Must match the secret_token given to
//                              setWebhook. Without it every update is refused:
//                              this endpoint writes phone numbers, so an
//                              unauthenticated one would let anybody set any
//                              user's phone.
// Injected: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
// ============================================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4'
import { timingSafeEqual } from '../_shared/telegram.ts'
import { COPY, isLang, LANGUAGE_BUTTONS, LANGUAGE_PROMPT, type Lang } from './copy.ts'

const BOT_TOKEN = Deno.env.get('TELEGRAM_BOT_TOKEN') ?? ''
const MINI_APP_URL = Deno.env.get('MINI_APP_URL') ?? ''
const WEBHOOK_SECRET = Deno.env.get('TELEGRAM_WEBHOOK_SECRET') ?? ''

const admin = createClient(
  Deno.env.get('SUPABASE_URL') ?? '',
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
  { auth: { persistSession: false } },
)

// ------------------------------------------------------------ Telegram ----

type Json = Record<string, unknown>

async function callTelegram(method: string, payload: Json): Promise<void> {
  const response = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  if (!response.ok) {
    // Log and carry on: a failed send must never make us return non-200, or
    // Telegram will redeliver the same update forever.
    console.error(`${method} failed: ${response.status} ${await response.text()}`)
  }
}

const send = (chatId: number, text: string, replyMarkup?: Json) =>
  callTelegram('sendMessage', {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
  })

// ------------------------------------------------------------- keyboards --

const languageKeyboard = () => ({
  inline_keyboard: [LANGUAGE_BUTTONS.map((b) => ({ text: b.text, callback_data: `lang:${b.lang}` }))],
})

/** request_contact only works on a reply keyboard, never an inline one. */
const contactKeyboard = (lang: Lang) => ({
  keyboard: [[{ text: COPY[lang].phoneButton, request_contact: true }]],
  resize_keyboard: true,
  one_time_keyboard: true,
})

const identityKeyboard = (lang: Lang) => ({
  inline_keyboard: [
    [{ text: COPY[lang].identityOwner, callback_data: 'id:owner' }],
    [{ text: COPY[lang].identityMakler, callback_data: 'id:makler' }],
    [{ text: COPY[lang].identityBoth, callback_data: 'id:both' }],
    [{ text: COPY[lang].identityBrowsing, callback_data: 'id:browsing' }],
  ],
})

const openAppKeyboard = (lang: Lang) => ({
  inline_keyboard: [[{ text: COPY[lang].openApp, web_app: { url: MINI_APP_URL } }]],
})

// ----------------------------------------------------------------- state --

interface State {
  telegram_id: number
  step: 'language' | 'phone' | 'full_name' | 'identity' | 'role_update' | 'language_update' | 'done'
  language: Lang | null
  phone: string | null
  full_name: string | null
}

async function loadState(telegramId: number): Promise<State | null> {
  const { data } = await admin
    .from('bot_onboarding_state')
    .select('*')
    .eq('telegram_id', telegramId)
    .maybeSingle()
  return (data as State | null) ?? null
}

async function saveState(telegramId: number, patch: Partial<Omit<State, 'telegram_id'>>): Promise<void> {
  const { error } = await admin
    .from('bot_onboarding_state')
    .upsert({ telegram_id: telegramId, ...patch, updated_at: new Date().toISOString() }, {
      onConflict: 'telegram_id',
    })
  if (error) console.error('saveState failed:', error.message)
}

const langOf = (state: State | null): Lang => (isLang(state?.language) ? state!.language! : 'en')

// ------------------------------------------------------------ completion --

// Neither flag is a real answer, not a missing one: that person is a client.
// users.role is retired -- the column keeps a default and nothing writes it.
const IDENTITIES = {
  owner: { is_owner: true, is_makler: false },
  makler: { is_owner: false, is_makler: true },
  both: { is_owner: true, is_makler: true },
  browsing: { is_owner: false, is_makler: false },
} as const

type IdentityKey = keyof typeof IDENTITIES

/**
 * Writes the finished profile to public.users. oikoz_id is deliberately not
 * supplied — the column DEFAULT mints it on insert, which is what guarantees
 * uniqueness and means a user created by telegram-auth gets one too.
 */
async function completeOnboarding(
  telegramId: number,
  state: State,
  identity: IdentityKey,
): Promise<{ oikozId: string; name: string } | null> {
  const flags = IDENTITIES[identity]
  const fullName = state.full_name ?? ''

  const { data, error } = await admin
    .from('users')
    .upsert(
      {
        telegram_id: telegramId,
        name: fullName, // keeps the Mini App's existing display name in sync
        full_name: fullName,
        phone: state.phone,
        language: langOf(state),
        is_owner: flags.is_owner,
        is_makler: flags.is_makler,
      },
      { onConflict: 'telegram_id' },
    )
    .select('oikoz_id, full_name, name')
    .single()

  if (error) {
    console.error('user upsert failed:', error.message)
    return null
  }

  await saveState(telegramId, { step: 'done' })
  return { oikozId: data.oikoz_id as string, name: (data.full_name ?? data.name ?? '') as string }
}

/**
 * /role — re-ask only the identity question. Language, phone and name are
 * already on file and do not change, so the whole conversation is one tap.
 */
async function startRoleUpdate(chatId: number, telegramId: number): Promise<boolean> {
  const { data: user } = await admin
    .from('users')
    .select('language')
    .eq('telegram_id', telegramId)
    .maybeSingle()

  // Never registered: /role has nothing to update, so run onboarding instead.
  if (!user) return false

  const state = await loadState(telegramId)
  const lang = isLang(state?.language) ? (state!.language as Lang) : isLang(user.language) ? (user.language as Lang) : 'en'

  await saveState(telegramId, { language: lang, step: 'role_update' })
  await send(chatId, COPY[lang].askIdentity, identityKeyboard(lang))
  return true
}

/**
 * /language — re-ask only the language question. Like /role, this reuses the
 * onboarding keyboard and touches nothing else on the profile.
 */
async function startLanguageUpdate(chatId: number, telegramId: number): Promise<boolean> {
  const { data: user } = await admin
    .from('users')
    .select('language')
    .eq('telegram_id', telegramId)
    .maybeSingle()

  if (!user) return false

  await saveState(telegramId, { step: 'language_update' })
  await send(chatId, LANGUAGE_PROMPT, languageKeyboard())
  return true
}

async function applyLanguageUpdate(
  telegramId: number,
  lang: Lang,
): Promise<{ oikozId: string; name: string } | null> {
  const { data, error } = await admin
    .from('users')
    .update({ language: lang })
    .eq('telegram_id', telegramId)
    .select('oikoz_id, full_name, name')
    .single()

  if (error) {
    console.error('language update failed:', error.message)
    return null
  }
  await saveState(telegramId, { language: lang, step: 'done' })
  return { oikozId: data.oikoz_id as string, name: (data.full_name ?? data.name ?? '') as string }
}

async function applyRoleUpdate(
  telegramId: number,
  identity: IdentityKey,
): Promise<{ oikozId: string; name: string } | null> {
  const flags = IDENTITIES[identity]
  const { data, error } = await admin
    .from('users')
    .update({ is_owner: flags.is_owner, is_makler: flags.is_makler })
    .eq('telegram_id', telegramId)
    .select('oikoz_id, full_name, name')
    .single()

  if (error) {
    console.error('role update failed:', error.message)
    return null
  }
  await saveState(telegramId, { step: 'done' })
  return { oikozId: data.oikoz_id as string, name: (data.full_name ?? data.name ?? '') as string }
}

// ------------------------------------------------------------- handlers ----

async function startConversation(chatId: number, telegramId: number): Promise<void> {
  const state = await loadState(telegramId)

  // Already onboarded: re-send the button instead of asking everything again.
  if (state?.step === 'done') {
    const { data } = await admin
      .from('users')
      .select('oikoz_id, full_name, name')
      .eq('telegram_id', telegramId)
      .maybeSingle()
    const lang = langOf(state)
    if (data) {
      const name = (data.full_name ?? data.name ?? '') as string
      await send(chatId, COPY[lang].alreadyDone(name, data.oikoz_id as string), openAppKeyboard(lang))
      return
    }
    // State says done but the profile is gone — fall through and redo it.
  }

  await saveState(telegramId, { step: 'language' })
  await send(chatId, LANGUAGE_PROMPT, languageKeyboard())
}

async function handleCallback(cq: Json): Promise<void> {
  const id = cq.id as string
  const data = (cq.data as string) ?? ''
  const from = cq.from as { id: number }
  const message = cq.message as { chat: { id: number }; message_id: number } | undefined
  if (!message) return

  const chatId = message.chat.id
  await callTelegram('answerCallbackQuery', { callback_query_id: id })

  // Clear the keyboard so the same choice cannot be tapped twice.
  await callTelegram('editMessageReplyMarkup', {
    chat_id: chatId,
    message_id: message.message_id,
    reply_markup: { inline_keyboard: [] },
  })

  if (data.startsWith('lang:')) {
    const lang = data.slice(5)
    if (!isLang(lang)) return

    const current = await loadState(from.id)
    if (current?.step === 'language_update') {
      const updated = await applyLanguageUpdate(from.id, lang)
      if (!updated) {
        await send(chatId, COPY[lang].restartHint)
        return
      }
      // Confirmation is written in the language they just picked.
      await send(chatId, COPY[lang].languageUpdated, openAppKeyboard(lang))
      return
    }

    await saveState(from.id, { language: lang, step: 'phone' })
    await send(chatId, COPY[lang].askPhone, contactKeyboard(lang))
    return
  }

  if (data.startsWith('id:')) {
    const identity = data.slice(3) as IdentityKey
    if (!(identity in IDENTITIES)) return

    const state = await loadState(from.id)
    const lang = langOf(state)

    // The same keyboard serves first-time onboarding and /role; the step says
    // which one asked, and therefore whether to write a whole profile or just
    // flip two flags.
    if (state?.step === 'role_update') {
      const updated = await applyRoleUpdate(from.id, identity)
      if (!updated) {
        await send(chatId, COPY[lang].restartHint)
        return
      }
      await send(chatId, COPY[lang].roleUpdated, openAppKeyboard(lang))
      return
    }

    if (!state || state.step !== 'identity') {
      await send(chatId, COPY[lang].unexpected)
      return
    }

    const result = await completeOnboarding(from.id, state, identity)
    if (!result) {
      await send(chatId, COPY[lang].restartHint)
      return
    }
    await send(chatId, COPY[lang].done(result.name, result.oikozId), openAppKeyboard(lang))
  }
}

/**
 * A contact shared from the public booking page. The Mini App cannot read the
 * phone itself -- requestContact() hands it to the bot as a message -- so this
 * is where it lands, and the page polls get-public-villa until it shows up.
 *
 * Only the sender's own number is taken: Telegram sets contact.user_id when a
 * person shares their own contact, and it must equal the sender. A forwarded
 * or typed-in contact card has no user_id or somebody else's, and is refused.
 * The update itself is trusted because the secret-token check above it fails
 * closed.
 *
 * Only an existing users row is updated. The page registers the visitor
 * (telegram-auth) before it ever asks for a phone.
 */
async function savePublicContact(
  chatId: number,
  telegramId: number,
  contact: { phone_number: string; user_id?: number },
): Promise<void> {
  const { data: user } = await admin
    .from('users')
    .select('language')
    .eq('telegram_id', telegramId)
    .maybeSingle()
  const lang: Lang = isLang(user?.language) ? (user!.language as Lang) : 'en'

  if (!user) {
    await send(chatId, COPY[lang].restartHint)
    return
  }

  if (contact.user_id !== telegramId) {
    await send(chatId, COPY[lang].phoneNotYours)
    return
  }

  const { error } = await admin
    .from('users')
    .update({ phone: contact.phone_number })
    .eq('telegram_id', telegramId)
  if (error) {
    console.error('public contact save failed:', error.message)
    await send(chatId, COPY[lang].phoneSaveFailed)
    return
  }

  await send(chatId, COPY[lang].phoneSaved)
}

/** Loose on purpose: Telegram hands back local formats as well as +E.164. */
const PHONE_RE = /^\+?\d[\d\s\-()]{6,20}$/

async function handleMessage(message: Json): Promise<void> {
  const chat = message.chat as { id: number }
  const from = message.from as { id: number } | undefined
  if (!from) return

  const chatId = chat.id
  const telegramId = from.id
  const text = ((message.text as string) ?? '').trim()
  const contact = message.contact as { phone_number: string; user_id?: number } | undefined

  if (text.startsWith('/start')) {
    await startConversation(chatId, telegramId)
    return
  }

  if (text.startsWith('/role')) {
    // Falls back to full onboarding if there is no profile to update yet.
    if (!(await startRoleUpdate(chatId, telegramId))) await startConversation(chatId, telegramId)
    return
  }

  if (text.startsWith('/language')) {
    if (!(await startLanguageUpdate(chatId, telegramId))) await startConversation(chatId, telegramId)
    return
  }

  const state = await loadState(telegramId)

  // A contact outside the onboarding phone step came from the public booking
  // page. Inside that step it is the onboarding answer, handled below.
  if (contact && state?.step !== 'phone') {
    await savePublicContact(chatId, telegramId, contact)
    return
  }

  if (!state) {
    await send(chatId, COPY.en.restartHint)
    return
  }
  const lang = langOf(state)

  switch (state.step) {
    case 'phone': {
      let phone: string | null = null

      if (contact) {
        // A user can forward somebody else's contact card; only take their own.
        if (contact.user_id && contact.user_id !== telegramId) {
          await send(chatId, COPY[lang].phoneNotYours, contactKeyboard(lang))
          return
        }
        phone = contact.phone_number
      } else if (PHONE_RE.test(text)) {
        phone = text
      }

      if (!phone) {
        await send(chatId, COPY[lang].phoneInvalid, contactKeyboard(lang))
        return
      }

      await saveState(telegramId, { phone, step: 'full_name' })
      // remove_keyboard retires the contact button now that it is answered.
      await callTelegram('sendMessage', {
        chat_id: chatId,
        text: COPY[lang].askName,
        reply_markup: { remove_keyboard: true },
      })
      return
    }

    case 'full_name': {
      if (text.length < 2) {
        await send(chatId, COPY[lang].nameTooShort)
        return
      }
      await saveState(telegramId, { full_name: text, step: 'identity' })
      await send(chatId, COPY[lang].askIdentity, identityKeyboard(lang))
      return
    }

    case 'language':
    case 'language_update':
      await send(chatId, LANGUAGE_PROMPT, languageKeyboard())
      return

    case 'identity':
    case 'role_update':
      await send(chatId, COPY[lang].askIdentity, identityKeyboard(lang))
      return

    case 'done':
      await startConversation(chatId, telegramId)
      return
  }
}

// ---------------------------------------------------------------- server ----

Deno.serve(async (req) => {
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Use POST' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  // The webhook URL is public and unauthenticated, so the shared secret from
  // setWebhook is the only thing proving an update really came from Telegram.
  // Fails closed: with no secret configured, nothing is accepted. Telegram
  // keeps retrying a refused update for a while, so updates sent during a
  // misconfiguration are delivered once it is fixed rather than lost.
  if (!WEBHOOK_SECRET) {
    console.error('TELEGRAM_WEBHOOK_SECRET is not set; refusing every update')
    return new Response(JSON.stringify({ error: 'Webhook secret not configured' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
    })
  }
  if (!timingSafeEqual(req.headers.get('X-Telegram-Bot-Api-Secret-Token') ?? '', WEBHOOK_SECRET)) {
    return new Response(JSON.stringify({ error: 'Bad secret token' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  if (!BOT_TOKEN || !MINI_APP_URL) {
    console.error('Missing TELEGRAM_BOT_TOKEN or MINI_APP_URL')
    return new Response('ok', { status: 200 })
  }

  // From here on we always answer 200. Telegram redelivers anything else, and
  // a redelivered update would re-run a conversation step the user already did.
  try {
    const update = (await req.json()) as Json
    if (update.callback_query) await handleCallback(update.callback_query as Json)
    else if (update.message) await handleMessage(update.message as Json)
  } catch (err) {
    console.error('update handling failed:', (err as Error).message)
  }

  return new Response('ok', { status: 200 })
})
