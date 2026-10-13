-- ============================================================================
-- Deposit receipts: the guest sends the bot a screenshot of their transfer,
-- and the owner's Deposit received / Not received message carries it.
--
-- "I've sent the deposit" on the public page no longer tells the owner by
-- itself. It opens the bot at t.me/oikoz_villa_bot?start=dr_<booking id>;
-- the bot asks for the receipt for that booking, and only when the screenshot
-- arrives -- or the guest taps "Send without receipt" -- is the hold marked
-- sent and the owner messaged. The receipt is evidence for the owner, never a
-- confirmation: only the owner's Deposit received confirms a booking.
--
-- Requires 0023 (and 0024 for the private 'receipts' bucket). Additive: one
-- column on bookings, one small table, one new function, and
-- bookings_status_guard() redefined (from 0023) with the new column added --
-- put it back from 0023 to undo that part.
--
-- STORAGE. Receipts go to the existing private 'receipts' bucket under
-- 'deposits/<booking_id>/<attempt>-<timestamp>.<ext>'. The bucket's only read
-- policy (0024) lets a user read the folder named after their own id;
-- 'deposits' is never anyone's id, so no app user -- guest, owner or makler --
-- can read these. The owner sees the image only as a Telegram photo, sent by
-- file id. No public URL exists.
--
-- RETENTION. Nothing deletes these files: not confirming, expiring,
-- cancelling or rejecting the booking, and not deleting the villa (which
-- removes the booking rows but never Storage objects). Find them with:
--
--   select name, created_at from storage.objects
--    where bucket_id = 'receipts' and name like 'deposits/%' order by created_at;
-- ============================================================================

-- ------------------------------------------- bookings: the current receipt ----
-- The receipt for the current attempt -- the one the owner's latest message
-- shows -- or null when the guest sent the deposit without one. A retry after
-- Not received replaces it; earlier attempts' files stay in the bucket.

alter table public.bookings add column if not exists deposit_receipt_path text;

-- ------------------------------------------------- status guardrail ----
-- As in 0023, plus deposit_receipt_path: only the bot records a receipt.

create or replace function public.bookings_status_guard()
returns trigger language plpgsql security invoker set search_path = public as $$
begin
  if current_user <> 'authenticated' then
    return new;
  end if;

  if tg_op = 'INSERT' then
    if new.status in ('pending', 'expired', 'rejected')
       or new.hold_expires_at is not null
       or new.client_marked_paid_at is not null
       or new.client_user_id is not null
       or new.deposit_not_received_count <> 0
       or new.deposit_receipt_path is not null
    then
      raise exception 'Deposit holds can only be created from the public booking page'
        using errcode = 'check_violation';
    end if;
    return new;
  end if;

  if old.status in ('pending', 'expired', 'rejected') then
    raise exception 'This booking is a deposit hold and cannot be changed in the app'
      using errcode = 'check_violation';
  end if;

  if new.status in ('pending', 'expired', 'rejected')
     or new.hold_expires_at is distinct from old.hold_expires_at
     or new.client_marked_paid_at is distinct from old.client_marked_paid_at
     or new.client_user_id is distinct from old.client_user_id
     or new.deposit_not_received_count is distinct from old.deposit_not_received_count
     or new.deposit_receipt_path is distinct from old.deposit_receipt_path
  then
    raise exception 'This booking is a deposit hold and cannot be changed in the app'
      using errcode = 'check_violation';
  end if;

  return new;
end $$;

-- ------------------------------------- which booking a receipt is for ----
-- One row per guest: the booking whose receipt the bot is waiting for. Set by
-- the deep link (/start dr_<booking id>), after the bot has checked that the
-- booking is this Telegram user's own live hold, or by the guest picking a
-- booking when a screenshot arrived and two of theirs were waiting. A newer
-- request replaces an older one, so the latest link always wins. Cleared once
-- the receipt is in.
--
-- Service role only: RLS on, no policies, nothing granted to app users.

create table if not exists public.deposit_receipt_requests (
  telegram_id  bigint      primary key,
  booking_id   uuid        not null references public.bookings (id) on delete cascade,
  requested_at timestamptz not null default now()
);

alter table public.deposit_receipt_requests enable row level security;
revoke all on public.deposit_receipt_requests from anon;
revoke all on public.deposit_receipt_requests from authenticated;
grant select, insert, update, delete on public.deposit_receipt_requests to service_role;

-- --------------------------------------------- "sent", with its receipt ----
-- What the bot calls once the screenshot is stored, or when the guest taps
-- "Send without receipt" (p_receipt_path null). One statement, so it is atomic
-- and two quick submissions serialize on the row lock:
--
--   * only the visitor who made the hold, only while it is live, and only if
--     it is not already marked sent -- a second screenshot for the same
--     attempt changes nothing and returns no row
--   * client_marked_paid_at set, and the hold extended to two hours from now,
--     exactly as mark_public_hold_paid() does on a first "sent" (a retry after
--     Not received cleared client_marked_paid_at, so it counts as a first)
--   * the receipt path recorded, or cleared when sent without one
--
-- It never touches status or deposit_paid. Only the owner confirms.

create or replace function public.submit_deposit_receipt(
  p_client_user_id uuid,
  p_booking_id     uuid,
  p_receipt_path   text
)
returns setof public.bookings
language sql security definer set search_path = public as $$
  update public.bookings
     set client_marked_paid_at = now(),
         hold_expires_at       = now() + interval '2 hours',
         deposit_receipt_path  = p_receipt_path
   where id = p_booking_id
     and client_user_id = p_client_user_id
     and status = 'pending'
     and hold_expires_at > now()
     and client_marked_paid_at is null
  returning *;
$$;

revoke all on function public.submit_deposit_receipt(uuid, uuid, text) from public;
revoke all on function public.submit_deposit_receipt(uuid, uuid, text) from anon;
revoke all on function public.submit_deposit_receipt(uuid, uuid, text) from authenticated;
grant execute on function public.submit_deposit_receipt(uuid, uuid, text) to service_role;
