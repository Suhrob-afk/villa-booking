-- ============================================================================
-- "Not received": the owner's retryable answer to "I've sent the deposit".
--
-- The owner's deposit message now has two buttons, Deposit received (the
-- existing confirm) and Not received, which replaces Reject. Not received
-- does not end the booking. The hold stays pending and keeps its dates, the
-- guest's "I've sent the deposit" is cleared so they can pay and tap it
-- again, and the hold runs for one more hour. A booking can be marked not
-- received twice; the third time releases the dates, as an expiry.
--
-- Requires 0020. Additive: one column on bookings, one on
-- booking_owner_messages (now part of its primary key), one new function, a
-- small private helper, and two trigger functions redefined --
-- bookings_status_guard (from 0018/0020) with the new column added, and
-- bookings_compute (from 0020) with one more early exit. Put those back from
-- 0020 to undo.
--
-- Old owner messages that still show Reject keep working:
-- reject_public_hold() is untouched.
-- ============================================================================

-- ------------------------------------------------- bookings: the counter ----
-- How many times the owner has said Not received. 0, 1 or 2 on a live hold;
-- the press that would make it 3 releases the dates instead.

alter table public.bookings
  add column if not exists deposit_not_received_count smallint not null default 0;

-- --------------------------------------------- one message per attempt ----
-- 0020 allowed one deposit message per booking, ever: the claim was on
-- (booking_id, kind). After Not received the guest pays again and taps
-- "I've sent the deposit" again, and the owner must get a fresh message with
-- both buttons. The attempt is the booking's deposit_not_received_count at
-- the time of that tap -- 0, then 1, then 2 -- so each new "sent" claims a new
-- row while a double tap on the same attempt still sends nothing twice.

alter table public.booking_owner_messages
  add column if not exists attempt smallint not null default 0;

do $$ begin
  if exists (
    select 1 from pg_constraint
     where conrelid = 'public.booking_owner_messages'::regclass
       and conname = 'booking_owner_messages_pkey'
       and array_length(conkey, 1) = 2
  ) then
    alter table public.booking_owner_messages drop constraint booking_owner_messages_pkey;
    alter table public.booking_owner_messages
      add constraint booking_owner_messages_pkey primary key (booking_id, kind, attempt);
  end if;
end $$;

-- ------------------------------------------------- status guardrail ----
-- As in 0020, plus the counter: only the server counts Not received.

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
  then
    raise exception 'This booking is a deposit hold and cannot be changed in the app'
      using errcode = 'check_violation';
  end if;

  return new;
end $$;

-- --------------------------------------------------------- money engine ----
-- As in 0020, with one more early exit (the second one below).

create or replace function public.bookings_compute()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v public.villas%rowtype;
  min_deposit constant numeric := 100000;  -- UZS, like every deposit
  floor_total numeric;
begin
  if tg_op = 'UPDATE'
     and old.status in ('pending', 'expired')
     and new.status in ('expired', 'rejected')
  then
    new.updated_at := now();
    return new;
  end if;

  -- A hold staying a hold, with only its bookkeeping changed: "I've sent the
  -- deposit", "Not received", the expiry moving. Nothing that prices it has
  -- moved, so there is nothing to recompute -- and recomputing would refuse
  -- the write if the credited channel makler has since dropped is_makler.
  if tg_op = 'UPDATE'
     and old.status = 'pending'
     and new.status = 'pending'
     and (new.villa_id, new.manager_id, new.check_in, new.check_out, new.total_price, new.currency,
          new.deposit_amount, new.pricing_mode, new.owner_net_amount)
         is not distinct from
         (old.villa_id, old.manager_id, old.check_in, old.check_out, old.total_price, old.currency,
          old.deposit_amount, old.pricing_mode, old.owner_net_amount)
  then
    new.updated_at := now();
    return new;
  end if;

  select * into v from public.villas where id = new.villa_id;
  if not found then
    raise exception 'Villa % does not exist', new.villa_id;
  end if;

  -- The villa's currency is only a starting point; an explicit choice wins.
  if new.currency is null then
    new.currency := lower(v.currency)::booking_currency;
  end if;

  -- Only a registered makler can be credited, however the row got here.
  if new.manager_id is not null
     and not exists (select 1 from public.users u where u.id = new.manager_id and u.is_makler)
  then
    raise exception 'The credited user is not registered as a Makler'
      using errcode = 'check_violation';
  end if;

  if tg_op = 'INSERT' then
    new.commission_rate_snapshot := v.commission_rate;
  else
    new.commission_rate_snapshot := old.commission_rate_snapshot;
  end if;

  if new.deposit_amount is null then
    new.deposit_amount := v.deposit_amount;
  end if;
  if new.deposit_amount < min_deposit then
    raise exception 'Deposit must be at least % — got %', min_deposit, new.deposit_amount
      using errcode = 'check_violation';
  end if;

  new.platform_fee := round(new.total_price * v.platform_fee_rate, 2);

  if new.manager_id is null then
    -- Owner-logged with nobody credited: no commission exists to calculate.
    new.owner_net_amount   := null;
    new.manager_commission := 0;
    new.owner_payout       := new.total_price - new.platform_fee;

  elsif new.pricing_mode = 'owner_net' then
    if new.owner_net_amount is null then
      raise exception 'Enter the owner''s net amount for this booking'
        using errcode = 'check_violation';
    end if;

    floor_total := new.owner_net_amount + new.platform_fee;
    if new.total_price < floor_total then
      raise exception
        'Total price must be at least the owner''s net amount (% + % platform fee = %)',
        new.owner_net_amount, new.platform_fee, floor_total
        using errcode = 'check_violation';
    end if;

    new.owner_payout       := new.owner_net_amount;
    new.manager_commission := new.total_price - new.owner_net_amount - new.platform_fee;

  else
    new.owner_net_amount   := null;
    new.manager_commission := round(new.total_price * new.commission_rate_snapshot, 2);
    new.owner_payout       := new.total_price - new.platform_fee - new.manager_commission;
  end if;

  new.updated_at := now();
  return new;
end $$;

-- ------------------------------------------ a lapsed hold, explained ----
-- The same three answers confirm_public_hold() (0020) gives for a hold whose
-- time ran out, for Not received to reuse:
--
--   expired_free    the dates are still free; the owner may "Confirm anyway"
--   expired_taken   they overlap a booking, a live hold or an owner block
--   expired_closed  never revivable: the guest has not said they paid, or
--                   check-in is already past
--
-- Private: called only from mark_deposit_not_received() below.

create or replace function public.lapsed_hold_outcome(b public.bookings)
returns text
language sql stable security definer set search_path = public as $$
  select case
    when b.client_marked_paid_at is null
         or b.check_in < (now() at time zone 'Asia/Tashkent')::date
      then 'expired_closed'
    when exists (
        select 1 from public.bookings o
         where o.villa_id = b.villa_id
           and o.id <> b.id
           and (o.status = 'confirmed' or (o.status = 'pending' and o.hold_expires_at > now()))
           and daterange(o.check_in, o.check_out, '[)') && daterange(b.check_in, b.check_out, '[)')
      )
      or exists (
        select 1 from public.blocked_dates d
         where d.villa_id = b.villa_id
           and daterange(d.start_date, d.end_date, '[)') && daterange(b.check_in, b.check_out, '[)')
      )
      then 'expired_taken'
    else 'expired_free'
  end;
$$;

revoke all on function public.lapsed_hold_outcome(public.bookings) from public;
revoke all on function public.lapsed_hold_outcome(public.bookings) from anon;
revoke all on function public.lapsed_hold_outcome(public.bookings) from authenticated;

-- ------------------------------------------------------- Not received ----
-- Returns jsonb { outcome, status, count, hold_expires_at }. Outcomes:
--
--   not_found        no such booking, or not one from the public page
--   not_owner        the tapper is not the villa owner: change nothing
--   already_handled  no longer a hold -- confirmed, rejected or cancelled
--   awaiting_guest   a live hold the guest has not (re-)marked as sent: a
--                    double tap, or a tap on an old message. Nothing changes
--   expired_free / expired_taken / expired_closed
--                    the hold already ran out. Never revived here; the owner
--                    gets the same offer Confirm gives
--   not_received     presses 1 and 2: "sent" cleared, one more hour, counted
--   released         press 3: the dates are freed, as an expiry
--
-- Locked FOR UPDATE, like confirm_public_hold(), so a Not received racing a
-- Deposit received, a double tap or the cron sweep all serialize here.

create or replace function public.mark_deposit_not_received(
  p_owner_telegram_id bigint,
  p_booking_id        uuid
)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  max_not_received constant smallint := 2;
  b        public.bookings%rowtype;
  owner_tg bigint;
begin
  select * into b from public.bookings where id = p_booking_id for update;
  if not found or b.client_user_id is null then
    return jsonb_build_object('outcome', 'not_found');
  end if;

  select u.telegram_id into owner_tg
    from public.villas v
    join public.users u on u.id = v.owner_id
   where v.id = b.villa_id;
  if owner_tg is null or owner_tg <> p_owner_telegram_id then
    return jsonb_build_object('outcome', 'not_owner');
  end if;

  if b.status not in ('pending', 'expired') then
    return jsonb_build_object('outcome', 'already_handled', 'status', b.status);
  end if;

  if b.status = 'expired' or b.hold_expires_at <= now() then
    return jsonb_build_object('outcome', public.lapsed_hold_outcome(b), 'status', b.status);
  end if;

  if b.client_marked_paid_at is null then
    return jsonb_build_object(
      'outcome', 'awaiting_guest', 'status', b.status,
      'count', b.deposit_not_received_count, 'hold_expires_at', b.hold_expires_at
    );
  end if;

  if b.deposit_not_received_count >= max_not_received then
    update public.bookings
       set status = 'expired',
           hold_expires_at = null,
           deposit_not_received_count = b.deposit_not_received_count + 1
     where id = b.id;
    return jsonb_build_object('outcome', 'released', 'status', 'expired',
                              'count', b.deposit_not_received_count + 1);
  end if;

  update public.bookings
     set client_marked_paid_at = null,
         hold_expires_at = now() + interval '1 hour',
         deposit_not_received_count = b.deposit_not_received_count + 1
   where id = b.id
  returning * into b;

  return jsonb_build_object(
    'outcome', 'not_received', 'status', b.status,
    'count', b.deposit_not_received_count, 'hold_expires_at', b.hold_expires_at
  );
end $$;

revoke all on function public.mark_deposit_not_received(bigint, uuid) from public;
revoke all on function public.mark_deposit_not_received(bigint, uuid) from anon;
revoke all on function public.mark_deposit_not_received(bigint, uuid) from authenticated;
grant execute on function public.mark_deposit_not_received(bigint, uuid) to service_role;
