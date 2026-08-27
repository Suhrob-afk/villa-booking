# Villa CRM — Telegram Mini App

A booking and commission tool for villa rentals, built as a Telegram Mini App on
Supabase. Two roles, many-to-many: an owner has villas, a manager works the
villas they are assigned to, and one villa can have several managers.

```
src/
  lib/         supabase client, Telegram bridge, auth, dates, pricing, data access
  components/  MonthCalendar (the Calendly-style grid) + shared UI
  screens/     Home · VillaSetup · VillaCalendar · BookingScreen · Commissions
supabase/
  migrations/0001_init.sql        schema, money triggers, RLS policies
  functions/telegram-auth/        initData verification → Supabase JWT
  seed.sql                        optional demo data
```

## How identity works

There is no Supabase Auth (GoTrue) user. Instead:

1. The app sends `window.Telegram.WebApp.initData` to the `telegram-auth` Edge
   Function.
2. The function verifies the HMAC with the bot token, so the payload provably
   came from Telegram, and rejects initData older than 24h.
3. It finds or creates `public.users` by `telegram_id`. On a first login the
   client must supply the role picked on the welcome screen (`owner` /
   `manager`).
4. It mints an HS256 JWT signed with the project's JWT secret, with
   `sub = users.id` and `role = authenticated`.
5. The client attaches that token to every PostgREST request, so `auth.uid()`
   inside RLS policies **is** `public.users.id`.

## Setup

### 1. Database

Run `supabase/migrations/0001_init.sql` in the Supabase SQL editor (or
`supabase db push` with the CLI). It is idempotent — safe to re-run.

### 2. Edge Function

```bash
supabase functions deploy telegram-auth --no-verify-jwt
```

`--no-verify-jwt` is required: this function is what *issues* the token, so it
cannot demand one.

Set its secrets (Project Settings → Edge Functions → Secrets, or the CLI):

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
button, and pick a role on first launch.

### 5. Linking managers

A manager signs in once, then reads their Telegram ID off the empty Home
screen. The owner opens **Villa setup → Managers → Add manager by Telegram ID**.
That calls the `link_manager_by_telegram_id` RPC, which refuses ids that are
not registered as managers.

## Working outside Telegram

For browser development, set `VITE_DEV_TELEGRAM_ID=999000001` in `.env` and
`ALLOW_DEV_LOGIN=true` on the Edge Function. The function then accepts an
unsigned `devTelegramId` and signs a token for it. **Never enable this in
production** — it is a complete authentication bypass.

## Business rules

**Pricing.** Currency and both rates live on the villa, never globally, because
one owner routinely mixes USD and UZS properties. Weekend is Saturday and
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

**Calendar.** Month grid, one circle per day. Light blue = available, solid
dark blue = booked, with consecutive booked days bridged into a single strip.
Managers tap a light day to open a pre-dated booking form; owners get a
read-only grid. Tapping a dark day opens that booking.

## Permissions (enforced in the database, not the UI)

| | Owner | Manager |
|---|---|---|
| See a villa | `villas.owner_id = auth.uid()` | listed in `villa_managers` |
| Edit villa, rates, commission | yes | no |
| Add/remove managers | yes | no |
| Create / edit a booking | no | yes, on their villas |
| Cancel or reopen a booking | yes | yes |
| Mark commission paid | yes | no |

RLS policies cover row visibility; two `BEFORE UPDATE` triggers cover what RLS
cannot express — which *columns* each side may touch on `bookings` and `users`.
Bookings are never deleted, only cancelled.

## Not in v1

Photos, payments, multi-owner villas, push notifications, and changing your own
role after signup (an admin has to do it with the service role).
