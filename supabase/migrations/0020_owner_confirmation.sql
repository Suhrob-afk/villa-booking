-- ============================================================================
-- Public booking pages, part 3: the owner confirms or rejects a deposit hold
-- from the bot.
--
-- Requires 0019 (the 'rejected' enum value) to have been run, and committed,
-- first -- in a separate SQL Editor run.
--
-- Everything here is additive: one new table, two new functions, and three
-- trigger functions redefined -- bookings_status_guard (from 0018) and
-- bookings_compute (from 0015) with 'rejected' added, and
-- bookings_update_guard (from 0012) made to restrain app users only. Put them
-- back from those files to undo.
--
-- Both new functions are executable by service_role alone. They are called
-- only by telegram-bot-webhook, whose updates are authenticated by the
-- webhook secret token, after a tap on the owner's Confirm / Reject buttons.
-- The tapper's Telegram id is passed in and checked HERE against the villa's
-- owner, so the ownership rule lives next to the write it protects.
-- ============================================================================

-- ------------------------------------------------- status guardrail ----
-- As in 0018, with 'rejected' treated like 'pending' and 'expired': an app
-- user may not create one, turn a booking into one, or change one -- not even
-- reopen it. Only the functions below (and the sweep) resolve a hold.

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
  then
    raise exception 'This booking is a deposit hold and cannot be changed in the app'
      using errcode = 'check_violation';
  end if;

  return new;
end $$;

-- ------------------------------------------------------ update guardrail ----
-- As in 0012, with one change: it now restrains app users only, like
-- bookings_status_guard() above.
--
-- It decides by auth.uid(), which is null for the service role and for the
-- functions below, so until now it treated server-side code as "neither owner
-- nor makler" and refused any change to a makler booking's fields. Confirming
-- a hold whose channel makler has since dropped is_makler has to clear
-- manager_id, and that write was being refused.
--
-- SECURITY INVOKER so current_user is the role that issued the write (see
-- 0016). is_villa_owner() / is_villa_manager() are SECURITY DEFINER helpers
-- and work the same from here. For app users nothing changes.

create or replace function public.bookings_update_guard()
returns trigger language plpgsql security invoker set search_path = public as $$
declare
  owner_here   boolean;
  manager_here boolean;
begin
  if current_user <> 'authenticated' then
    return new;
  end if;

  owner_here   := public.is_villa_owner(new.villa_id);
  manager_here := public.is_villa_manager(new.villa_id);

  if not owner_here and new.commission_status is distinct from old.commission_status then
    raise exception 'Only the villa owner can change commission status';
  end if;

  if not manager_here and old.manager_id is not null then
    if (new.villa_id, new.manager_id, new.client_name, new.client_phone,
        new.check_in, new.check_out, new.total_price, new.notes,
        new.deposit_amount, new.pricing_mode, new.owner_net_amount, new.currency)
       is distinct from
       (old.villa_id, old.manager_id, old.client_name, old.client_phone,
        old.check_in, old.check_out, old.total_price, old.notes,
        old.deposit_amount, old.pricing_mode, old.owner_net_amount, old.currency)
    then
      raise exception 'This booking belongs to a makler — you can cancel it or settle its commission';
    end if;
  end if;

  return new;
end $$;

-- --------------------------------------------------------- money engine ----
-- As in 0015, with the early exit widened: releasing a hold -- it lapsing
-- ('expired') or the owner refusing it ('rejected') -- changes nothing but its
-- status, so there is nothing to recompute, and recomputing could refuse the
-- write (e.g. the credited makler has since dropped is_makler).
--
-- Confirming a hold does NOT take this exit: pending -> confirmed runs the
-- full computation, exactly like any other confirmed booking.

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

-- --------------------------------------------- owner bot messages ----
-- One row per (booking, kind) the bot has messaged the owner about:
--
--   hold_created  the heads-up when a visitor first holds dates
--   deposit_sent  the visitor tapped "I've sent the deposit": the message with
--                 the Confirm received / Reject buttons
--
-- The row is claimed (inserted) BEFORE sending, so two simultaneous taps or a
-- retried request cannot message the owner twice. A failed send keeps its
-- row, with sent_at null and Telegram's error text, so a hold whose owner was
-- never told can be found with:
--
--   select * from public.booking_owner_messages where sent_at is null;
--
-- Service role only: RLS on, no policies, nothing granted to app users.

create table if not exists public.booking_owner_messages (
  booking_id uuid        not null references public.bookings (id) on delete cascade,
  kind       text        not null,
  chat_id    bigint,
  message_id bigint,
  sent_at    timestamptz,
  error      text,
  created_at timestamptz not null default now(),
  primary key (booking_id, kind),
  constraint booking_owner_messages_kind check (kind in ('hold_created', 'deposit_sent'))
);

alter table public.booking_owner_messages enable row level security;
revoke all on public.booking_owner_messages from anon;
revoke all on public.booking_owner_messages from authenticated;
grant select, insert, update, delete on public.booking_owner_messages to service_role;

-- ------------------------------------------------- confirming a hold ----
-- Returns jsonb { outcome, status } -- status is the booking's status after
-- the call. Outcomes:
--
--   not_found        no such booking, or not one from the public page
--   not_owner        p_owner_telegram_id is not the villa owner's -- the
--                    caller must ignore the tap and change nothing
--   confirmed        THIS call confirmed it (so the caller notifies the guest)
--   already_handled  it is no longer a hold: confirmed, rejected or cancelled
--   expired_free     the hold lapsed; the dates are still free and it may be
--                    confirmed anyway with p_reconfirm = true
--   expired_taken    the hold lapsed and its dates now overlap another
--                    booking, a live hold or an owner block
--   expired_closed   the hold lapsed and may not be revived: the guest never
--                    said they had paid, or check-in is already in the past
--
-- A lapsed hold is never confirmed silently: only with p_reconfirm = true
-- (the owner tapped "Confirm anyway" after being told it had expired). That
-- covers both a row the sweep has already set to 'expired' and a 'pending'
-- one whose hold_expires_at has passed but which the sweep has not reached.
--
-- The row is locked first (FOR UPDATE), so a double tap, a Confirm racing a
-- Reject, or the cron sweep racing either, all serialize here, and each later
-- caller sees the earlier one's result.
--
-- Confirming credits the hold's makler only while they are still a makler --
-- the same "credit nobody rather than fail the guest" rule as
-- create_public_hold(). The overlap constraint and bookings_block_guard() are
-- the final word on the dates: if either refuses, the answer is expired_taken.

create or replace function public.confirm_public_hold(
  p_owner_telegram_id bigint,
  p_booking_id        uuid,
  p_reconfirm         boolean default false
)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  b        public.bookings%rowtype;
  owner_tg bigint;
  today    date := (now() at time zone 'Asia/Tashkent')::date;
  lapsed   boolean;
  taken    boolean;
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

  lapsed := b.status = 'expired' or (b.status = 'pending' and b.hold_expires_at <= now());

  if b.status not in ('pending', 'expired') then
    return jsonb_build_object('outcome', 'already_handled', 'status', b.status);
  end if;

  if lapsed then
    if b.client_marked_paid_at is null or b.check_in < today then
      return jsonb_build_object('outcome', 'expired_closed', 'status', b.status);
    end if;

    taken := exists (
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
      );

    if taken then
      return jsonb_build_object('outcome', 'expired_taken', 'status', b.status);
    end if;
    if not p_reconfirm then
      return jsonb_build_object('outcome', 'expired_free', 'status', b.status);
    end if;
  end if;

  begin
    update public.bookings
       set status          = 'confirmed',
           deposit_paid    = true,
           hold_expires_at = null,
           manager_id      = case
             when manager_id is not null
                  and not exists (select 1 from public.users u where u.id = manager_id and u.is_makler)
             then null
             else manager_id
           end
     where id = b.id;
  exception when exclusion_violation or check_violation then
    -- Only reachable for a lapsed hold: a live one already owns its nights.
    return jsonb_build_object('outcome', 'expired_taken', 'status', b.status);
  end;

  return jsonb_build_object('outcome', 'confirmed', 'status', 'confirmed');
end $$;

revoke all on function public.confirm_public_hold(bigint, uuid, boolean) from public;
revoke all on function public.confirm_public_hold(bigint, uuid, boolean) from anon;
revoke all on function public.confirm_public_hold(bigint, uuid, boolean) from authenticated;
grant execute on function public.confirm_public_hold(bigint, uuid, boolean) to service_role;

-- --------------------------------------------------- rejecting a hold ----
-- Same shape and owner check as above. Outcomes: not_found, not_owner,
-- rejected (THIS call rejected it), already_handled.
--
-- A live hold's nights are released immediately: 'rejected' is outside the
-- overlap constraint's (confirmed, pending) predicate. A hold that has
-- already lapsed can be rejected too -- its nights are free either way, but
-- the owner said no, and the guest should hear that rather than nothing.
-- Neither 'rejected' nor 'expired' is ever revenue, commission or a
-- cancellation.

create or replace function public.reject_public_hold(
  p_owner_telegram_id bigint,
  p_booking_id        uuid
)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
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

  update public.bookings
     set status = 'rejected',
         hold_expires_at = null
   where id = b.id;

  return jsonb_build_object('outcome', 'rejected', 'status', 'rejected');
end $$;

revoke all on function public.reject_public_hold(bigint, uuid) from public;
revoke all on function public.reject_public_hold(bigint, uuid) from anon;
revoke all on function public.reject_public_hold(bigint, uuid) from authenticated;
grant execute on function public.reject_public_hold(bigint, uuid) to service_role;
