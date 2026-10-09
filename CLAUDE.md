# Oikoz: Telegram Mini App villa CRM

Stack: React + Supabase (Postgres, RLS, Edge Functions). Bot: @oikoz_villa_bot.
Languages: en / ru / uz.

## Surfaces

- **Mini App** — two nav tabs, Villas and Dashboard. Opened from Telegram; all
  of it sits behind `telegram-auth`.
- **`/admin`** — a separate page, not a screen of the Mini App. Its own password
  (`ADMIN_PANEL_PASSWORD`), no Telegram context, split into its own bundle, and
  it imports nothing from the app's auth, screens or navigation.

## Domain

- Users: `is_owner` / `is_makler` booleans. Neither = client.
  - **`users.role` still exists.** Migration `0004` retired it — gave it a
    default of `'manager'` and removed its last consumer — but never dropped it;
    the column is still `NOT NULL`. Nothing reads or writes it, yet a raw insert
    or a migration that assumes it is gone will break, and
    `users_update_guard()` names it explicitly among the columns a user may not
    change about themselves.
- IDs: `users.oikoz_id` = `oikoz_id0001...`; `villas.villa_code` =
  `villa_id0001...` (literal prefix, four zero-padded digits, no separator).
- `villa_managers` = join table. The UI calls them "Maklers".
- Bookings: per-booking currency (`uzs` | `usd`), chosen at booking time with
  the villa's currency only as the default. **`deposit_amount` is ALWAYS UZS**,
  minimum 100,000, whatever the price is in. Pricing modes:
  `'percentage'` | `'owner_net'`. `manager_id` is nullable — an owner-logged
  booking credits nobody and owes no commission.
- Villas are UZS or USD only (`villas_currency_supported`), because a booking
  has to be able to default to the villa's currency.
- `blocked_dates` table, owner-only, RLS via `is_villa_owner()`.
- Overlap protection: GiST exclusion constraint on `bookings`, covering
  `status IN ('confirmed','pending')`; half-open ranges, so a check-out day can
  be the next check-in.
- Booking statuses: `confirmed`, `cancelled`, `pending` (a deposit hold from
  the public booking page, live only while `hold_expires_at > now()`),
  `expired` (a lapsed hold) and `rejected` (the owner tapped Reject in the
  bot). Neither `expired` nor `rejected` is ever revenue, commission **or** a
  cancellation.
  App users can't create, edit or confirm holds (`bookings_status_guard`); only
  service-role edge functions do. Any read that shows availability must treat
  pending as occupying nights only while `hold_expires_at > now()`, because an
  expired hold can stay `pending` for up to two minutes until the sweep.
- Owner payout card: `villa_payout_details`, owner-only RLS. Never put it on
  `villas`, because linked maklers can read the whole villa row.
- Guard triggers that test `current_user` must be `SECURITY INVOKER`: inside a
  SECURITY DEFINER function `current_user` is the owner (postgres), which made
  `users_update_guard` and `villas_delete_guard` no-ops until `0016`. The
  booking guards (`bookings_status_guard`, `bookings_update_guard` since
  `0020`) restrain app users only; server-side writes skip them.
- Villa removal: delete only with zero bookings, otherwise archive
  (`villas.archived_at`). `villas_delete_guard()` enforces it in the database,
  because `bookings.villa_id` cascades.
- Edge functions: `telegram-auth` (verifies initData HMAC, issues session;
  registers a bare client when opened from a live villa's booking link),
  `telegram-bot-webhook` (onboarding, `/role`, `/language`, and saving a phone
  shared from the public page), `link-manager`, `exchange-rate` (CBU USD/UZS
  rate, read-through cached in `exchange_rates`), `admin-users`, and the
  public booking page's `get-public-villa`, `create-public-booking` and
  `mark-deposit-sent`. Shared code lives in `supabase/functions/_shared/`;
  every function importing it must be redeployed when it changes.
- `telegram-bot-webhook` fails closed: it refuses every update unless
  `TELEGRAM_WEBHOOK_SECRET` is set and matches the `secret_token` given to
  `setWebhook`, because it writes phone numbers.
- Public holds: `bookings.client_user_id` is the visitor who made the hold.
  Created only through `create_public_hold()` (30 min, max 2 live per
  visitor); "I've sent the deposit" (`mark_public_hold_paid()`) extends the
  hold to two hours from the first tap only and never sets `deposit_paid`.
  Both functions are executable by `service_role` alone.
- Public booking form (`0021`): name (`client_name`), guests
  (`guests_count`, 1 to the villa's capacity, or 30 when none is set), client
  type (`client_type`) and an optional note (`notes`, 300 chars max), all
  validated by the eight-argument `create_public_hold()`. The four-argument
  version from `0018` is only kept for the deploy window. `get-public-villa`
  returns other people's nights anonymously in `unavailable` and the
  visitor's own bookings separately in `my_bookings`.
- Owner confirmation (`0020`): `mark-deposit-sent` sends the owner a bot
  message with Confirm received / Reject (`bk:c|rc|r:<booking id>`). That is
  the owner's only message per booking: there is no heads-up on hold
  creation. `telegram-bot-webhook` resolves taps
  through `confirm_public_hold()` / `reject_public_hold()`, which check the
  tapper is the villa owner. A lapsed hold is never confirmed silently, only
  via "Confirm anyway" while its dates are free, the guest marked it paid and
  check-in is not past. `booking_owner_messages` records each owner message
  (one per booking and kind); failed sends keep `sent_at` null and are logged
  as `[owner-notify] FAILED`.
- pg_cron runs exactly one job, `oikoz-release-expired-holds`, every two
  minutes (`0017`). The exchange rate is still not scheduled; it refreshes on
  demand when the cached row is no longer from today.

## Rules

- DB changes: new numbered, idempotent migration files. Never edit applied ones.
  From v2 on, the user pastes each one into the SQL Editor themselves, so give
  the exact run order and never assume one has been applied. An `ALTER TYPE
  ... ADD VALUE` goes in a file of its own, because the editor runs a script as
  one transaction.
- Never trust client input: verify initData server-side for anything sensitive.
- **Money is never summed across currencies.** Group per currency, in a single
  villa's totals as well as across villas. The one exception is the Dashboard's
  explicitly-labelled combined figure, converted at today's CBU rate and shown
  with that rate beside it.
- Revenue and commission screens count only `status = 'confirmed'`. The single
  exception is the Dashboard Overview, which reports cancelled bookings as their
  own figure — it still never counts them as sales.
- All UI strings live in the en/ru/uz dictionary (`t()`), and every new string
  needs real ru + uz text. The `/admin` page is the one deliberate exception: it
  is English-only, because `t()` reads the signed-in user's language and that
  page has no signed-in user.
- Shared `TopBar` / `ProfileHeader` / `TabBar` are used by both owner and makler
  views. Change them there, not per screen.
- Run typecheck and build before saying a task is done.

## Gotchas

Each of these has already cost a session real time.

- **This machine is UTC+5.** `toISOString()` on a local-midnight Date rolls the
  date back a day. `src/lib/dates.ts` avoids UTC conversion entirely for that
  reason — any new date code or test fixture must format locally too.
- **`git push` has to run in the user's own terminal.** The sandboxed Bash tool
  cannot reach the macOS keychain, so it offers a credential GitHub rejects —
  which then looks like an expired token and is not. Use the terminal tool, and
  confirm the result with `git ls-remote` rather than trusting the command's
  own output.
- **The Supabase MCP connection points at a different organisation** and cannot
  see this project. The Supabase CLI is authenticated and linked to the right
  one — use it.
- **The service worker caches `/assets/` cache-first and nothing else that way**,
  and never registers outside a production build. It previously cache-firsted
  every same-origin GET, which pinned Vite's unhashed `/src/*` modules and made
  edits appear not to apply. `/version.json` must stay uncached: it is what gets
  a new deploy onto a long-lived Telegram WebView.
- Writes are refused while offline, never queued — replaying an edit could
  double-book a villa somebody else booked in the meantime.
