-- ============================================================================
-- Public booking pages, part 2: who holds a hold, and the two server-side
-- operations the public page needs.
--
-- Requires 0014-0017. Everything here is additive: one nullable column, one
-- index, two new functions, and bookings_status_guard() redefined with one
-- extra rule (put it back from 0015 to undo that part).
--
-- Neither new function is callable by an app user. They are executed only by
-- the create-public-booking and mark-deposit-sent Edge Functions, which run as
-- service_role after verifying the visitor's Telegram initData.
-- ============================================================================

-- ------------------------------------------------- bookings: the visitor ----
-- The users row of the visitor who created a hold on the public page. Null on
-- every booking logged inside the app. It is what lets the page show a visitor
-- their own hold (and its card number) and nobody else's, enforce the
-- two-holds-per-visitor limit, and accept "I've sent the deposit" only from
-- the person who made the hold.

alter table public.bookings add column if not exists client_user_id uuid;

do $$ begin
  alter table public.bookings
    add constraint bookings_client_user_id_fkey
    foreign key (client_user_id) references public.users (id) on delete set null;
exception when duplicate_object then null; end $$;

-- The rate limit counts a visitor's live holds; the page looks up their latest.
create index if not exists bookings_client_user_idx
  on public.bookings (client_user_id, created_at desc)
  where client_user_id is not null;

-- ------------------------------------------------- status guardrail ----
-- As in 0015, plus: an app user may not set or change client_user_id. That
-- column decides whose hold a booking is, so only server-side code writes it.

create or replace function public.bookings_status_guard()
returns trigger language plpgsql security invoker set search_path = public as $$
begin
  if current_user <> 'authenticated' then
    return new;
  end if;

  if tg_op = 'INSERT' then
    if new.status in ('pending', 'expired')
       or new.hold_expires_at is not null
       or new.client_marked_paid_at is not null
       or new.client_user_id is not null
    then
      raise exception 'Deposit holds can only be created from the public booking page'
        using errcode = 'check_violation';
    end if;
    return new;
  end if;

  if old.status in ('pending', 'expired') then
    raise exception 'This booking is a deposit hold and cannot be changed in the app'
      using errcode = 'check_violation';
  end if;

  if new.status in ('pending', 'expired')
     or new.hold_expires_at is distinct from old.hold_expires_at
     or new.client_marked_paid_at is distinct from old.client_marked_paid_at
     or new.client_user_id is distinct from old.client_user_id
  then
    raise exception 'This booking is a deposit hold and cannot be changed in the app'
      using errcode = 'check_violation';
  end if;

  return new;
end $$;

-- --------------------------------------------------- creating a hold ----
-- Every check and the insert run in one transaction. Failures are raised as
-- 'oikoz:<code>' so the Edge Function can turn them into friendly messages:
--
--   not_found       no live villa with that code
--   not_accepting   the owner has not entered a payout card yet
--   phone_required  the visitor has no phone on file
--   invalid_dates   past check-in, empty range, over 60 nights, over a year out
--   too_many_holds  the visitor already has two live holds (any villa)
--   dates_taken     an owner block, or the overlap constraint
--
-- Race safety for the dates is the bookings_no_overlap exclusion constraint
-- (0015), not a read-then-write check: two visitors racing for one weekend
-- both reach the INSERT, and the constraint refuses the second.
--
-- The two-hold limit is made race-safe by a per-visitor advisory lock, so two
-- quick taps cannot each count one existing hold and both insert.
--
-- Prices: Saturday and Sunday nights at the weekend rate, every other night at
-- the weekday rate -- the same rule as quoteRange() in src/lib/pricing.ts, so
-- the page's live total is what gets stored. The money split is left to
-- bookings_compute() like any other booking: manager_id null means no
-- commission; otherwise percentage mode on the villa's commission_rate.

create or replace function public.create_public_hold(
  p_client_user_id uuid,
  p_villa_code     text,
  p_check_in       date,
  p_check_out      date
)
returns public.bookings
language plpgsql security definer set search_path = public as $$
declare
  v        public.villas%rowtype;
  visitor  public.users%rowtype;
  makler   uuid;
  today    date := (now() at time zone 'Asia/Tashkent')::date;
  total    numeric(14, 2);
  live     integer;
  created  public.bookings%rowtype;
begin
  select * into v from public.villas where villa_code = p_villa_code and archived_at is null;
  if not found then
    raise exception 'oikoz:not_found';
  end if;

  if not exists (select 1 from public.villa_payout_details where villa_id = v.id) then
    raise exception 'oikoz:not_accepting';
  end if;

  select * into visitor from public.users where id = p_client_user_id;
  if not found then
    raise exception 'oikoz:not_found';
  end if;
  if coalesce(trim(visitor.phone), '') = '' then
    raise exception 'oikoz:phone_required';
  end if;

  if p_check_in is null
     or p_check_out is null
     or p_check_out <= p_check_in
     or p_check_in < today
     or p_check_in > today + 365
     or p_check_out - p_check_in > 60
  then
    raise exception 'oikoz:invalid_dates';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('oikoz-public-hold:' || p_client_user_id::text, 0));

  select count(*) into live
    from public.bookings
   where client_user_id = p_client_user_id
     and status = 'pending'
     and hold_expires_at > now();
  if live >= 2 then
    raise exception 'oikoz:too_many_holds';
  end if;

  -- An owner block is checked here so it reads as "taken" rather than leaking
  -- its reason through bookings_block_guard()'s message.
  if exists (
    select 1 from public.blocked_dates d
     where d.villa_id = v.id
       and daterange(d.start_date, d.end_date, '[)') && daterange(p_check_in, p_check_out, '[)')
  ) then
    raise exception 'oikoz:dates_taken';
  end if;

  select sum(case when extract(isodow from night) in (6, 7) then v.weekend_price else v.weekday_price end)
    into total
    from generate_series(p_check_in::timestamp, (p_check_out - 1)::timestamp, interval '1 day') as night;

  -- Credit the villa's channel makler only while they are still a makler.
  -- Someone who has since dropped the flag would make bookings_compute()
  -- refuse the guest; crediting nobody is the better failure.
  select u.id into makler
    from public.users u
   where u.id = v.default_channel_makler_id
     and u.is_makler;

  begin
    insert into public.bookings (
      villa_id, manager_id, client_user_id, client_name, client_phone,
      check_in, check_out, total_price, currency, deposit_amount, pricing_mode,
      status, hold_expires_at
    ) values (
      v.id, makler, visitor.id,
      coalesce(nullif(trim(visitor.full_name), ''), nullif(trim(visitor.name), ''), 'Telegram guest'),
      visitor.phone,
      p_check_in, p_check_out, total, lower(v.currency)::booking_currency, v.deposit_amount, 'percentage',
      'pending', now() + interval '30 minutes'
    )
    returning * into created;
  exception when exclusion_violation then
    raise exception 'oikoz:dates_taken';
  end;

  return created;
end $$;

revoke all on function public.create_public_hold(uuid, text, date, date) from public;
revoke all on function public.create_public_hold(uuid, text, date, date) from anon;
revoke all on function public.create_public_hold(uuid, text, date, date) from authenticated;
grant execute on function public.create_public_hold(uuid, text, date, date) to service_role;

-- ----------------------------------------- "I've sent the deposit" ----
-- Records the visitor's claim and gives the owner time to check it: the hold
-- is extended to two hours from the FIRST tap. Repeated taps change nothing --
-- coalesce() keeps the first timestamp, and the CASE only extends when this
-- update is the one setting it. One statement, so two simultaneous taps
-- serialize on the row lock and the second sees the first one's values.
--
-- deposit_paid is NOT touched. Only the owner confirming receipt sets it
-- (Phase 3), and that confirmation must itself refuse a hold whose
-- hold_expires_at has passed.
--
-- Only the visitor who created the hold, and only while it is live. Returns no
-- row otherwise; the Edge Function reads the hold back to say why.

create or replace function public.mark_public_hold_paid(p_client_user_id uuid, p_booking_id uuid)
returns setof public.bookings
language sql security definer set search_path = public as $$
  update public.bookings
     set hold_expires_at = case
           when client_marked_paid_at is null then now() + interval '2 hours'
           else hold_expires_at
         end,
         client_marked_paid_at = coalesce(client_marked_paid_at, now())
   where id = p_booking_id
     and client_user_id = p_client_user_id
     and status = 'pending'
     and hold_expires_at > now()
  returning *;
$$;

revoke all on function public.mark_public_hold_paid(uuid, uuid) from public;
revoke all on function public.mark_public_hold_paid(uuid, uuid) from anon;
revoke all on function public.mark_public_hold_paid(uuid, uuid) from authenticated;
grant execute on function public.mark_public_hold_paid(uuid, uuid) to service_role;
