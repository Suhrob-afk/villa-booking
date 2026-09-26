# Villa CRM — Telegram Mini App

A booking and commission tool for villa rentals, built as a Telegram Mini App on
Supabase. A person can be an **owner**, a **Makler** (manager), or both at once
— an owner has villas, a manager works the villas they're assigned to, one
villa can have several managers, and the same person routinely plays both
parts (a Makler who also owns a villa or two, an owner who occasionally books
for other owners).

```
src/
  lib/         supabase client, Telegram bridge, auth, dates, pricing, data access
  components/  MonthCalendar (the Calendly-style grid) + shared UI
  screens/     Onboarding · Home · VillaSetup · VillaCalendar · BookingScreen · Commissions
supabase/
  migrations/0001_init.sql              schema, money triggers, RLS policies
  migrations/0002_revoke_anon.sql       locks the anon role out of every table
  migrations/0003_multi_role_oikoz_id.sql  dual roles, oikoz_id, telegram_id lockdown
  functions/telegram-auth/              initData verification, registration → Supabase JWT
  functions/link-manager/               links a manager by oikoz_id, DMs them on success
  seed.sql                              optional demo data
```

## How identity works

There is no Supabase Auth (GoTrue) user. Instead:

1. The app sends `window.Telegram.WebApp.initData` to the `telegram-auth` Edge
   Function.
2. The function verifies the HMAC with the bot token, so the payload provably
   came from Telegram, and rejects initData older than 24h.
3. It looks up `public.users` by `telegram_id`. If the person doesn't exist
   yet (or is missing a name/phone/role), the function replies
   `{ needsRegistration: true, missingFields, telegram: { id, name } }`
   instead of a token, and the app shows the **Onboarding** screen — full
   name, contact number, and one or both of "I own villas" / "I manage
   bookings". Submitting that calls the same function again with the answers,
   which creates the row and mints the token in one round trip.
4. On creation, a Postgres function (`generate_oikoz_id()`) mints a unique
   public id like `oikoz_id0001` — this, never the Telegram id, is what people
   hand each other to link accounts (see below).
5. The function mints an HS256 JWT signed with the project's JWT secret, with
   `sub = users.id` and `role = authenticated`.
6. The client attaches that token to every PostgREST request, so `auth.uid()`
   inside RLS policies **is** `public.users.id`.

`telegram_id` is column-privilege-revoked from the `authenticated` role at the
database level (migration `0003`) — it is never selectable by a signed-in
client, not even by accident through `select('*')`. `oikoz_id` is the only
identifier that ever reaches the frontend.

## Roles: `is_owner` / `is_manager`

Earlier drafts used a single `role` enum. v1 uses two independent booleans
instead, because the two roles are not mutually exclusive in practice:

- `is_owner` — can create/edit villas, set rates and commission, link and
  unlink managers, mark commissions paid.
- `is_manager` — can create bookings on villas they're linked to, and sees
  their own commission.
- Both — Home and Commissions show an owner section and a manager section
  side by side (or a segmented "As owner / As manager" toggle on Commissions),
  instead of forcing a single view.

At least one must be true (`users_has_a_role` check constraint); registration
enforces this in the UI too. Once set at signup, a person can't flip their own
roles later — that needs the service role, same as before.

**Owner and Makler are sections, not screens.** `Home` is a single component
that renders "My Villas" and/or "Villas Assigned to Me" from the two flags,
under one `ProfileHeader`; the bottom nav is rendered once in `App.tsx`,
outside the routes. Nothing about the header or nav is written twice, so a
change to either lands in every view at once. Anything role-specific goes in
`ProfileHeader`'s `action` slot (today: the owner's "add villa" button) rather
than into a second copy of the header.

## Linking a manager to a villa

1. Every user gets an `oikoz_id` the moment they register (owner or manager,
   doesn't matter — it's not role-specific).
2. A manager shares their `oikoz_id` with an owner (in person, in chat,
   however).
3. The owner opens **Villa setup → Managers → Add manager by oikoz ID** and
   enters it. This calls the `link-manager` Edge Function, which runs the
   `link_manager_by_oikoz_id` RPC under the caller's own JWT (so ordinary RLS
   decides whether the link is allowed — the function doesn't reimplement
   permission checks) and, on success, sends the manager a Telegram DM telling
   them which villa and owner just added them.
4. If an owner later unlinks a manager, that manager keeps read-only access to
   their own past bookings and commissions on that villa (RLS's
   `was_villa_manager()`), so historical earnings never disappear — they just
   stop seeing it as an active assignment.

## Setup

### 1. Database

Run the migrations in order in the Supabase SQL editor (or `supabase db
push` with the CLI) — `0001_init.sql`, then `0002_revoke_anon.sql`, then
`0003_multi_role_oikoz_id.sql`. Each is idempotent — safe to re-run.

### 2. Edge Functions

```bash
supabase functions deploy telegram-auth --no-verify-jwt
supabase functions deploy link-manager --no-verify-jwt
supabase functions deploy exchange-rate --no-verify-jwt
supabase functions deploy admin-users --no-verify-jwt
```

`--no-verify-jwt` is required for `telegram-auth` because it's what *issues*
the token, so it can't demand one first. `link-manager` also needs it because
it does its own bearer-token handling (forwarding the caller's JWT to a
scoped Supabase client) rather than relying on the platform's default JWT
check.

Set secrets once (Project Settings → Edge Functions → Secrets, or the CLI) —
both functions share the same project secrets:

```bash
supabase secrets set TELEGRAM_BOT_TOKEN=123456:ABC... APP_JWT_SECRET=<legacy JWT secret>
```

`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are injected automatically.

> **Why `APP_JWT_SECRET` and not `SUPABASE_JWT_SECRET`?** The platform silently
> refuses any secret whose name begins with `SUPABASE_` — it prints
> `Env name cannot start with SUPABASE_, skipping` and carries on, so the
> function would deploy and then fail at runtime.

> **Which secret:** the project's legacy HS256 JWT secret (Project Settings →
> API → JWT Settings). If your project has moved to asymmetric JWT signing
> keys, keep the legacy shared secret enabled, or change `mintJwt()` to sign
> with the current key — PostgREST must be able to verify what this function
> signs.

### 3. Frontend

```bash
cp .env.example .env      # fill in VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY
npm install
npm run dev
```

Build and host the `dist/` folder anywhere static (Vercel and Netlify configs
for SPA fallback are included):

```bash
npm run build
```

### 4. Telegram

In [@BotFather](https://t.me/botfather): `/newapp` (or Bot Settings → Menu
Button), point it at your deployed HTTPS URL. Open the bot, tap the menu
button — first-time visitors land on Onboarding (name, phone, owner/manager/
both) and get their oikoz ID on the spot.

## Working outside Telegram

For browser development, set `VITE_DEV_TELEGRAM_ID=999000001` in `.env` and
`ALLOW_DEV_LOGIN=true` on the Edge Function. The function then accepts an
unsigned `devTelegramId` and signs a token for it (still going through the
same registration flow on first use). **Never enable this in production** —
it is a complete authentication bypass.

## Admin panel

`/admin` is a separate page, not a screen of the Mini App. It opens in an
ordinary browser tab, imports nothing from the app's auth flow, screens or
navigation, and is split into its own bundle — on `/admin` the Mini App's code
is never even loaded, so no Telegram bridge is touched and no router mounts.

It asks for one password, then shows a read-only list of users (name, phone,
oikoz id, role, language, joined). Nothing on it edits or deletes. The password
is held in memory only: no `localStorage`, no cookie, so a reload asks again.

The `admin-users` Edge Function is what enforces that password, and it is the
*only* thing protecting the list — there is no Telegram initData and no
Supabase JWT in play, which is why it queries with the service role. So:

```bash
supabase secrets set ADMIN_PANEL_PASSWORD='<long random value, used nowhere else>'
```

Until that secret exists the function returns 503 and queries nothing, so it is
safe to deploy before setting it. An unset secret is never treated as an empty
password. The comparison is timing-safe and a wrong password costs a fixed
delay, but neither substitutes for length — this endpoint is public, and it
returns every user's name and phone number.

`telegram_id` is deliberately not among the columns it selects.

## Language

Three languages: English, Russian and Uzbek. `public.users.language` is the
single source of truth, and both surfaces read and write that same column —
the bot's `/language` command and the globe control in the app's `ProfileHeader`
(top right of Home). Whichever one a person used last is what both speak; the app
re-reads the user row whenever the Mini App returns to the foreground, so a
change made in the bot shows up on next open without a reload.

App copy lives in `src/lib/strings.ts` — a flat `Record<Lang, …>` lookup with
`{placeholder}` interpolation, deliberately the same shape as the bot's
`telegram-bot-webhook/copy.ts`, and no i18n runtime. `Record<Lang,
Record<StringKey, string>>` is what keeps it honest: a key added to English
fails the build until Russian and Uzbek have it too. Counted text goes through
`plural()`, which knows that Russian needs three forms (1 ночь / 3 ночи /
5 ночей) where English needs two and Uzbek needs none. Month and weekday names
live there too, so `formatRange()` and `monthLabel()` take a `Lang`.

Components read it through `useI18n()`: `t('key', vars)` and `tn(base, count)`.

> **Money is still formatted `en-US`** (`$1,234.00`), in every language. That
> is deliberate — changing separator and currency-symbol placement per locale
> would restyle every financial figure in the app, which is a bigger decision
> than translating the labels around them.

## Business rules

**Pricing.** Both nightly rates live on the villa. Currency lives on the
**booking**: the villa's currency (UZS or USD) is only the default a new
booking starts from, because owners routinely charge different clients in
different currencies for the same villa on the same night — $100 to one group,
1,000,000 UZS to another. Every money column on a booking (`total_price`,
`platform_fee`, `manager_commission`, `owner_payout`, `owner_net_amount`) is in
that booking's `currency`; nothing is ever converted. The villa's rates are in
the villa's currency, so they only pre-fill a booking priced in that same
currency. Any total — Breakdown, Commissions, the villa's month card — is
grouped per currency and never summed across them, for one villa exactly as for
several. **Deposits are the exception: always UZS**, whatever the price is in,
with a minimum of 100,000 for both the villa default and each booking.

**Combined total.** On top of the per-currency cards — which stay the accurate
ground truth — Breakdown and Commissions show one approximate USD figure,
converted at the Central Bank of Uzbekistan's published USD/UZS rate. The rate
is cached in `public.exchange_rates`, one row per currency: the `exchange-rate`
Edge Function reads through that cache and only calls `cbu.uz` when the stored
rate is no longer from today (Tashkent time). If the bank is unreachable it
serves the last rate it held, labelled as such; with nothing stored at all it
returns 503 and the client simply drops the combined line rather than showing a
wrong one. The combined figure also hides itself when only one currency is in
play, or when some amount is in a currency the rate does not cover — a partial
sum presented as a total would be worse than no total.

Totals are converted at *today's* rate, not the rate of the period being
viewed, so a past month's combined figure moves a little from day to day. That
is why the rate and its date are always printed beside it: nothing is locked
historically, and the label says so rather than hiding it. Weekend is Saturday and
Sunday; weekday is Monday–Friday. A booking's total is pre-filled by summing
each night at its own rate, and the manager can then overwrite it (a "Reset
to …" button restores the calculated figure).

**The split.** Computed by a database trigger, not the client:

```
platform_fee       = total_price × villa.platform_fee_rate
manager_commission = total_price × commission_rate_snapshot
owner_payout       = total_price − platform_fee − manager_commission
```

`commission_rate_snapshot` is frozen from the villa when the booking is
created, so changing a villa's rate later never rewrites past bookings. The
booking form previews exactly the same arithmetic while you type.

**Nights.** A stay occupies `[check_in, check_out)` — the checkout day is free
for the next guest. A GiST exclusion constraint enforces that no two
*confirmed* bookings on a villa overlap; cancelling releases the nights
immediately.

**Owner-logged bookings.** When an owner logs a booking on their own villa
there is no makler to credit and therefore no commission to split, so that
form drops client name, phone, the makler credit and the split panel
entirely — these are arranged by phone outside the app, and Notes holds
anything worth writing down. `client_name` is NOT NULL, so those rows store an
empty string and every list falls back to a label via `bookingTitle()`. A
makler's own booking is unchanged: client, phone and the full split stay.

**Logging after the fact.** An empty day in the past is tappable. It still
renders muted — it is not availability on offer — but it opens the booking
form so a stay that already happened can be recorded, and it counts towards
revenue like any other booking (attributed to the period containing its
check-in). Blocking a past day is meaningless, so a past day skips the
block-vs-log choice and goes straight to the form. A past day that *has* a
confirmed booking keeps rendering as booked, not as past.

**Removing a villa.** No bookings: a real delete. Any bookings at all,
cancelled included: archive instead. `bookings.villa_id` is `ON DELETE
CASCADE`, so deleting a villa with history would take its bookings — and the
payouts and commissions counted from them — with it. `villas_delete_guard()`
(migration `0011`) refuses that in the database rather than trusting the UI.
Archiving is just `villas.archived_at`: the rows do not move, so an archived
villa still counts everywhere revenue is aggregated, including Breakdown's
"all my villas". It leaves the active list only, and Home's "Archived villas"
disclosure restores it.

**Calendar.** Month grid, one circle per day. Light blue = available, solid
dark blue = booked, with consecutive booked days bridged into a single strip.
Managers tap a light day to open a pre-dated booking form; owners get a
read-only grid. Tapping a dark day opens that booking.

## Permissions (enforced in the database, not the UI)

| | Owner | Manager (currently assigned) | Manager (unassigned) |
|---|---|---|---|
| See a villa | `villas.owner_id = auth.uid()` | listed in `villa_managers` | no |
| Edit villa, rates, commission | yes | no | no |
| Add/remove managers | yes | no | no |
| Create / edit a booking | no | yes, on their villas | no |
| See their own past bookings/commissions | — | yes | yes (history only) |
| Cancel or reopen a booking | yes | yes | no |
| Mark commission paid | yes | no | no |

RLS policies cover row visibility; two `BEFORE UPDATE` triggers cover what RLS
cannot express — which *columns* each side may touch on `bookings` and
`users`. Bookings are never deleted, only cancelled.

**What a person may change about themselves:** `name`, `full_name`, `phone`
and `language` — nothing else. `users_update_guard()` enforces that list
(migration `0010`), and it is an *allowlist*: `id`, `telegram_id`, `oikoz_id`,
`role`, `is_owner`, `is_makler` and `created_at` are all refused, as is any
column added later until it is named. The guard only applies to the
`authenticated` role, so the bot webhook and `telegram-auth` — which run as
`service_role` and legitimately write roles during onboarding and `/role` —
are unaffected.

## Not in v1

Photos, payments, multi-owner villas, push notifications beyond the
manager-linked DM, and changing your own name/phone/roles after signup (an
admin has to do it with the service role).
