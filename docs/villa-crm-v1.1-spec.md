# Villa CRM — v1.1 Spec
### Bot-first onboarding + Owner page buildout

This extends the existing spec. It does not change `telegram-auth` — that function
still verifies the Mini App session once someone opens it. This adds a **new**
front door: a bot conversation that runs *before* the app ever opens.

---

## 1. Data model changes

### `users` — new/changed columns
| field | type | notes |
|---|---|---|
| is_owner | boolean | default false |
| is_makler | boolean | default false |
| language | enum | `en` \| `ru` \| `uz` |
| phone | text | captured via Telegram's native contact-share button |
| full_name | text | explicitly typed by the user, distinct from their Telegram display name |
| oikoz_id | text | short human-friendly reference (e.g. `OKZ-0001`), auto-generated on creation, unique, purely for display/reference — not used in relations |

Remove/deprecate the old single `role` enum — replace all `role === 'owner'` checks
in the app with `is_owner`, and `role === 'manager'` checks with `is_makler`.
A user with both flags true sees both the Owner and Makler views as two
separate sections on the same home screen (see section 3).
A user with both flags false is a "client" — v1 shows them a simple
"This page isn't ready yet" placeholder screen, nothing else. Importantly,
the **backend registration still fully happens** for these users — name,
phone, language, and their `oikoz_id` are all captured and stored via the
bot conversation exactly like everyone else. The placeholder only affects
what they see in the Mini App; the data is there for whenever the client
experience gets built later.

### `villas` — new columns
| field | type | notes |
|---|---|---|
| deposit_amount | numeric | flat default deposit in the villa's currency, owner-editable, default 250000, minimum 200000 (enforced in the form) |
| villa_code | text | short human-friendly reference (e.g. `VIL-0001`), auto-generated on creation, unique, purely for display/reference — used when talking about "which villa" in commissions, revenue reports, etc. without exposing the internal UUID |

### `bookings` — new column
| field | type | notes |
|---|---|---|
| deposit_amount | numeric | pre-filled from the villa's default, editable per booking, minimum 200000 enforced |

### New table: `bot_onboarding_state`
Tracks where each Telegram user is in the registration conversation, so the bot
can resume correctly if they close Telegram mid-flow or send `/start` again.

| field | type | notes |
|---|---|---|
| telegram_id | bigint | primary key |
| step | enum | `language` \| `contact` \| `name` \| `identity` \| `done` |
| language | enum | set once chosen |
| phone | text | set once shared |
| full_name | text | set once typed |
| updated_at | timestamp | |

---

## 2. The bot conversation (new Edge Function: `telegram-bot-webhook`)

This is a **Telegram Bot API webhook**, not the Mini App. Telegram calls this
function directly whenever a user messages the bot or taps a button.

### Setup requirement
After deploying, register the webhook once via:
```
https://api.telegram.org/bot<TOKEN>/setWebhook?url=<function URL>
```

### Conversation script

**Step 0 — trigger:** user sends `/start` (first time) or the bot has no
completed record for this `telegram_id`.

**Step 1 — language**
Bot sends inline keyboard: `English` / `Русский` / `O'zbekcha`
→ stores `language`, advances to `contact`

**Step 2 — contact**
Bot sends a message with Telegram's native "Share phone number" button
(a `request_contact` keyboard button — this is a real Telegram feature,
not a custom UI).
→ on receiving `message.contact`, stores `phone`, advances to `name`

**Step 3 — name**
Bot asks "What's your full name?" as plain text.
→ stores `full_name` from the next text message, advances to `identity`

**Step 4 — identity**
Bot sends inline keyboard: `Villa Owner` / `Makler` / `Both` / `Just browsing`
→ sets `is_owner`/`is_makler` accordingly, writes the final row into `users`,
marks `bot_onboarding_state.step = 'done'`

**Step 5 — done**
Bot sends a short confirmation message with a **Web App button** labeled
"Open App", pointing at the Mini App URL. This is the same style of button
BotFather's menu button uses, but sent inline as part of this message so it
appears right after registration completes.

### Resuming
If a user sends `/start` again after completing onboarding, skip straight to
step 5 (re-send the Open App button) rather than restarting the whole flow.

### Localization
All bot copy (steps 1–5) needs English/Russian/Uzbek versions. Keep these as a
simple lookup object keyed by language code — this function is small enough
that a single object of message templates is enough, no i18n library needed.

---

## 3. Owner page — three sections

A user with both `is_owner` and `is_makler` true sees **both** "My Villas" and
"Villas Assigned to Me" as separate sections (not a switcher) — simplest to
build, and matches how these two roles actually differ day to day.

**Parked idea — one-time referral commission:** a makler who brings a client
to a villa they have no standing assignment to (found via a Telegram channel
post, word of mouth, etc.) should eventually be able to get one-off commission
credit without a permanent `villa_managers` link. This needs its own tracking
(who gets credit for *this specific booking* vs. a standing assignment) and is
a real feature, not a small tweak — deliberately deferred past v1. Flagging so
it doesn't get lost.

### A. My Villas (existing, one addition)
The owner's own villas: same villa list + Calendly-style calendar as before,
renamed from "Villas" to "My Villas" to sit alongside the new section below.
One behavior change to the calendar itself:

**Tapping an unbooked (light) date now opens a small info card instead of
going straight to the booking form:**
- "Not booked"
- That day's rate (weekday or weekend price, whichever applies)
- The deposit amount for this villa
- A button to proceed to the actual booking form from here

This gives the owner a quick glance at pricing without committing to creating
a booking, and doubles as a preview of what a future public booking page
would show a client.

### B. Villas Assigned to Me
For any user with `is_makler` true: the villas they're linked to via
`villa_managers` (across any number of owners), shown with the same calendar
and booking-creation flow that's already built — this is functionally the
existing "manager" view, just named and grouped as its own section rather
than folded into a generic villa list.

### C. Maklers
List of maklers linked to this owner's villas (this is the existing
`villa_managers` join table, renamed in the UI from "Managers" to "Maklers").
Each row: name, phone number. Reuses the existing "link by Telegram ID" flow
to add a new one.

### D. Commissions
Proposed structure (confirm this matches your mental model):
- Running total owed **per makler**, at the top
- Below: a list of bookings with open commission, each showing makler name,
  villa, dates, commission amount, and a paid/unpaid toggle
- Filter or tab between "unpaid" and "all time" if the list gets long

---

## 4. Resolved decisions

1. **Both owner + makler** — shown as two separate sections ("My Villas" and
   "Villas Assigned to Me"), not a switcher.
2. **Deposit** — default 250,000, editable per booking, hard minimum 200,000
   enforced in the form.

## 5. Resolved: client role
Simple "This page isn't ready yet" placeholder. Full registration (name,
phone, language, oikoz_id) still happens in the backend regardless — nothing
about their data capture changes, only what they see in the app.

---

## 6. Claude Code prompts — run as two separate sessions

Run Part 1 first and fully test it (message the bot, confirm it walks
through registration and lands you in the app) before starting Part 2.
Keeping them separate means if something breaks, you know immediately
which half caused it.

---

### PART 1 — Bot onboarding engine
*(new backend only — does not touch the Mini App or existing screens)*

```
I'm extending an existing Telegram Mini App CRM (villa-crm). Add a new,
separate Telegram bot conversation flow that runs BEFORE the Mini App opens,
as the registration/onboarding step. This does not touch the existing
telegram-auth Edge Function or any existing frontend screens.

New Supabase Edge Function: telegram-bot-webhook
- Receives Telegram Bot API webhook updates (messages, callback_query,
  contact shares)
- Tracks each user's conversation step in a new bot_onboarding_state table
  (telegram_id, step, language, phone, full_name, updated_at)
- Conversation steps:
  1. Language choice via inline keyboard [English/Русский/O'zbekcha]
  2. Request phone number via Telegram's native request_contact button
  3. Ask full name as free text
  4. Identity choice via inline keyboard [Villa Owner/Makler/Both/
     Just browsing]
- On completion, upsert into the users table: language, phone, full_name,
  is_owner (bool), is_makler (bool) — both false means "just browsing"/
  client. Also generate and store a unique oikoz_id (short human-friendly
  reference like OKZ-0001, auto-incrementing or otherwise guaranteed
  unique) on every new user regardless of their role choice.
- Send a final message with an inline Web App button labeled "Open App"
  pointing at the deployed Mini App URL
- If a user messages /start after already completing onboarding, skip
  straight to re-sending the Open App button rather than restarting
  the conversation
- All bot copy (all 4 steps plus the final message) needs English/
  Russian/Uzbek versions, stored as a simple lookup object keyed by
  language code — no i18n library needed for this

After building, tell me the exact command/URL needed to register this
function as the bot's webhook via the Telegram Bot API, so I can run it
myself.
```

---

### PART 2 — App-side restructuring
*(run only after Part 1 is confirmed working end to end)*

```
Continuing work on the villa-crm Telegram Mini App. The backend now sets
is_owner and is_makler booleans on each user (via a separate onboarding
bot, already built) — replace all remaining uses of the old single `role`
column in the app with these two booleans.

Schema additions:
- Add deposit_amount (numeric, default 250000) to the villas table
- Add villa_code (text, unique, auto-generated short reference like
  VIL-0001) to the villas table, for human-friendly display only — not
  used in any relations
- Add deposit_amount (numeric) to the bookings table, pre-filled from the
  villa's deposit_amount default, editable per booking, with a hard
  minimum of 200000 enforced (reject lower values with a clear error)

Restructure the app into these sections, visible based on the user's
flags:
- "My Villas" (is_owner=true): the owner's own villas, existing calendar
  and booking flow, just renamed from "Villas"
- "Villas Assigned to Me" (is_makler=true): villas linked via
  villa_managers, same calendar/booking flow, shown as its own section
  rather than folded into a generic villa list
- A user with both flags sees both sections on the same home screen, not
  a merged view or switcher
- A user with neither flag (client) sees a simple "This page isn't ready
  yet" placeholder and nothing else
- Rename "Managers" references to "Maklers" in the UI (the underlying
  villa_managers join table can keep its name)

Update the villa calendar: tapping an unbooked (available) date should
first show a small info card with "Not booked", that day's rate
(weekday/weekend price), and the villa's deposit_amount, with a button
to proceed to the full booking form — rather than opening the booking
form immediately.

Change villa-linking so it works by oikoz_id, not raw Telegram ID. Right
now the "ask an owner to add you" screen shows the person's numeric
Telegram ID, which defeats the point of having a friendly reference
number — nobody wants to read out a 10-digit number over the phone.
Update the linking function to resolve by oikoz_id instead, and update
that screen to show/ask for the oikoz_id.

Add a Commissions screen for owners: running total owed per makler at
the top, then a list of bookings with open commission (makler name,
villa, dates, commission amount, paid/unpaid toggle).
```
