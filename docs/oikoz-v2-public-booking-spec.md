# Oikoz v2 — Public Villa Booking Pages
### Spec + build prompt, split into 3 parts

This is a new capability layered on top of the existing app, not a
replacement. Reuses existing infrastructure: villa_code as the public
identifier, the "credit a makler" mechanism, the existing bookings
table and GiST overlap constraint, and the existing bot-notification
pattern.

---

## Decisions locked in

- **Payment: Tier 1 (manual card transfer) for now.** The page shows
  the owner's own card number; client transfers manually and marks
  "I've sent it"; owner confirms receipt. No payment gateway API, no
  business registration required to launch. Tier 2 (real Click/Payme/
  Uzum integration) is a future upgrade — the booking/notification
  system underneath won't need to change when that happens, only how
  the deposit gets confirmed.
- **Deposit only** is collected through this flow, not full price —
  same as the existing in-app deposit concept.
- **Telegram-only.** No separate public website. The booking page is a
  Telegram Mini App reached via a direct link
  (t.me/oikoz_villa_bot/open?startapp=villa_id0003), which also works
  fine when placed in an Instagram bio, since t.me links open the
  Telegram app directly on mobile.
- **First-time visitors don't need to message the bot first.** The
  public booking page can register someone as a bare client (is_owner=
  false, is_makler=false) on the spot using their Telegram name (free
  via initData) — phone is only requested at the moment they actually
  try to book, via the same native contact-share button used
  elsewhere in the app.

---

## PART 1 — Schema and owner-side setup

```
Add to villas:
- payout_card_number (text, nullable) — the owner's own card number,
  shown publicly on their villa's booking page for manual transfers
- default_channel_makler_id (uuid, nullable, fk to users) — optional,
  same concept as the existing "credit a makler" field on owner-direct
  bookings, but as a standing default for this villa's public/channel
  bookings specifically

Extend the bookings status handling to support a temporary hold state:
- Add 'pending' as a valid status alongside the existing confirmed/
  cancelled
- Add hold_expires_at (timestamp, nullable) — only set when status =
  'pending'
- A pending hold with a future hold_expires_at should block those dates
  on the calendar exactly like a confirmed booking, but should NOT
  count toward the existing GiST exclusion constraint the same way
  confirmed bookings do (a pending hold shouldn't permanently reserve
  dates against future migrations) — check with existing constraint
  design and extend it to also cover non-expired pending rows if that's
  the cleaner approach, since you have full context on how it was
  originally built.
- Set up a scheduled cleanup (pg_cron, running every few minutes) that
  deletes or cancels 'pending' bookings whose hold_expires_at has
  passed, so expired holds automatically release their dates.

In Villa Setup, add:
- A field for the owner to enter their own payout_card_number
- The existing "credit a makler" style oikoz_id field, but for
  default_channel_makler_id (optional, villa-level default)
- A "Share booking link" button that generates and displays
  t.me/oikoz_villa_bot/open?startapp={villa_code}, with a copy-to-
  clipboard action — this is what the owner pastes into Instagram bios
  or Telegram channel posts
```

## PART 2 — Public booking page

```
Add a new screen reached via the Mini App's startapp parameter: when
the app opens with startapp=villa_id0003 (or similar), instead of the
normal authenticated app flow, show a public villa booking page for
that villa, regardless of who's opening it.

If the visitor has no existing user row, auto-create one as a bare
client (is_owner=false, is_makler=false) using their name from Telegram
initData — do not send them through the bot's onboarding conversation
first. If they already have a user row (returning visitor, or an
existing owner/makler checking their own listing), use that.

Page contents:
- Villa name, location, weekday/weekend prices, minimum deposit amount
- The existing calendar visual (available/booked/blocked states),
  adapted for a two-tap range selection: tap a check-in date, then an
  check-out date, rather than the internal app's single-tap-opens-form
  behavior
- Live total for the selected range (nights x rate) and the deposit
  amount
- Owner's display name and payout_card_number shown clearly once a
  range is selected and the visitor taps "Reserve"

Booking flow:
1. Visitor selects dates, taps "Reserve & Pay Deposit"
2. If their phone isn't already on file, request it via the native
   Telegram contact-share button (same pattern as bot onboarding)
3. Create a 'pending' booking: the selected dates, deposit_amount from
   the villa, hold_expires_at = now + 30 minutes, manager_id set from
   the villa's default_channel_makler_id if one exists (else null,
   same zero-commission behavior as existing owner-direct bookings with
   no credited makler)
4. Show the owner's card number and a "I've sent the deposit" button
5. Tapping it flags the booking as awaiting owner confirmation (don't
   mark deposit_paid = true yet — that only happens once the owner
   confirms, see Part 3) and shows the visitor a waiting/confirmation
   screen
6. If hold_expires_at passes without owner confirmation, the pending
   booking is cleaned up (per Part 1) and the visitor sees an
   "This reservation expired, please try again" state if they return
```

## PART 3 — Owner confirmation flow

```
When a visitor marks "I've sent the deposit" on a pending public
booking, send the villa's owner a Telegram message via the existing
bot (same messaging capability already used for other notifications):
client name, phone, dates, deposit amount, and two inline buttons:
"Confirm received" and "Reject."

Confirm received: flips the booking's status from 'pending' to
'confirmed', sets deposit_paid = true, clears hold_expires_at. This
permanently locks the dates (now covered by the existing overlap
protection for confirmed bookings) and the booking now appears
everywhere confirmed bookings already appear — the calendar, the
revenue breakdown screen, Commissions if a makler was credited.

Reject: cancels the pending booking immediately (rather than waiting
for the 30-minute expiry), releasing the dates right away — useful if
the owner immediately knows something's wrong (no transfer received,
suspicious request, etc).

Confirm this whole path is testable end to end: visit a villa's public
link as a fresh Telegram account with no prior history, complete a
booking, confirm it as the owner, and see it land correctly in the
existing calendar and revenue views.
```

---

## Suggested order

Run these as three separate Claude Code sessions, in order, testing
each before moving to the next — this touches the booking status model
(Part 1), a genuinely new unauthenticated-entry-point screen (Part 2),
and a new bot notification type (Part 3), and each is independently
verifiable before building on top of it.
