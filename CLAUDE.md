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
  - `users.telegram_username` (`0022`, no @) is written only by
    `telegram-auth` from signed initData, refreshed on each sign-in;
    `users_update_guard()` stops users setting it. Owners and maklers read a
    public guest's name and username through `villa_booking_clients()`, since
    `users_select` does not cover guests.
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
  `card_holder_name` (`0026`) sits beside the number and follows the same
  rules: guests get exactly the number and the name, only on their own live,
  unpaid hold (`payoutCard()` / `toPublicHold()`). An owner saving a card in
  the app must give the name (`oikoz:card_name_required`); cards from before
  `0026` have none and keep working, with a nudge in Villa Setup and on the
  Home villa card.
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
- Owner confirmation (`0020`, `0023`): each "I've sent the deposit" sends the
  owner a bot message with ✅ Deposit received / ⚠️ Not received
  (`bk:c|n:<booking id>`; `bk:rc` is "Confirm anyway"). There is no heads-up
  on hold creation. `telegram-bot-webhook` resolves taps through
  `confirm_public_hold()` / `mark_deposit_not_received()`, which check the
  tapper is the villa owner.
  - Not received keeps the hold `pending`, clears `client_marked_paid_at` and
    gives one more hour; the guest can pay and tap "sent" again, which
    extends to two hours and sends the owner a fresh message. Twice at most
    (`deposit_not_received_count`); the third press releases the dates as
    `expired`.
  - Reject (`bk:r`, status `rejected`) is no longer offered but still works on
    owner messages sent before `0023`.
  - Deposit receipts (`0025`): "I've sent the deposit" opens the bot at
    `?start=dr_<booking id>`; the bot names the booking only after checking it
    is the sender's own live hold (else one generic reply), and asks for a
    screenshot or "Send without receipt". `submit_deposit_receipt()` then
    marks it sent (two hours) and the owner gets ONE message -- the receipt as
    a photo with the details as caption, or text saying there is none. A
    receipt never confirms. Files: private `receipts` bucket under
    `deposits/<booking_id>/<attempt>-<ms>.<ext>`, sent to the owner by
    Telegram file id only. `deposit_receipt_requests` remembers which booking
    a guest's next screenshot is for. `mark-deposit-sent` is no longer called
    by the app (kept for cached old pages).
  - A lapsed hold is never confirmed silently, only via "Confirm anyway" while
    its dates are free, the guest marked it paid and check-in is not past.
  - `booking_owner_messages` records each owner message, one per (booking,
    kind, attempt) where attempt is the Not received count at the time;
    failed sends keep `sent_at` null and are logged as `[owner-notify] FAILED`.
- Subscriptions (`0024`): 49,000 UZS for 30 days, per account. The gate is
  on THE VILLA'S OWNER, not the person acting: any change to a villa (the
  villa, its payout card, maklers, bookings, blocked dates) needs that villa's
  owner to have `has_active_subscription()` (paid_until + 3 days of grace),
  so a makler is read-only on a lapsed owner's villa and is never charged.
  Creating a villa needs the creator's own subscription, whatever their role
  flags say. Enforced by `subscription_write_guard()` triggers, which test
  `auth.uid()` (so they also catch SECURITY DEFINER RPCs) and raise
  `oikoz:subscription_required` / `oikoz:villa_owner_inactive`; `api.ts`
  translates both. Server-side writes carry no `auth.uid()` and pass. A lapsed
  owner's villa takes no new public holds (`bookings_paused_guard`,
  `oikoz:bookings_paused`); existing bookings and holds are untouched.
  Time is granted only by `mark_subscription_paid()`, reached only through a
  `PaymentProvider`'s `markPaid` (`_shared/payments/`). Today's provider is
  `ManualPaynetProvider`: QR from `telegram-bot-webhook/assets/paynet-qr.png`
  (bundled via `static_files`, gitignored), receipts in the private
  `receipts` bucket, and only `ADMIN_TELEGRAM_ID` may tap Confirm / Reject.
  `/admin` shows subscriptions read-only and never receipts. Verify scripts
  for earlier phases seed fixture owners a subscription when the table exists.
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

## Parked

Agreed, not built yet.

- **A bot message to the guest when a hold simply expires.** Today the guest
  hears "Your reservation wasn't confirmed" only on the third Not received (or
  an old Reject); a plain expiry just shows Expired on the booking page. The
  2-minute sweep runs inside Postgres and cannot call Telegram, so this needs
  a scheduled Edge Function (or pg_net) that finds newly expired holds.

- **Cleaning up receipt images.** Deposit receipts (`receipts/deposits/...`)
  and subscription receipts (`receipts/<user_id>/...`) are kept forever:
  nothing deletes them, and deleting a villa removes its bookings but never
  their Storage files. A scheduled job could, for example, delete a
  booking's `deposits/<booking_id>/` 90 days after check-out or once a hold
  ends unconfirmed.

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
