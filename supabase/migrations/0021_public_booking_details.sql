-- ============================================================================
-- Public booking pages: the guest's booking details.
--
-- The booking form now asks for a name, the number of guests, the client
-- type and an optional note. Three of those already have columns from earlier
-- migrations and are reused as they are:
--
--   client_name  (0001)  the name the guest typed, pre-filled from Telegram
--   client_type  (0008)  the existing client_type enum, same seven values
--   notes        (0001)  the guest's optional note, at most 300 characters
--
-- Only the number of guests is new.
--
-- Requires 0018-0020. Additive: one nullable column and one new overload of
-- create_public_hold(). The four-argument version from 0018 is left in place
-- on purpose, so the deployed create-public-booking keeps working between
-- running this file and deploying the new function. Nothing calls it after
-- that deploy; a later migration can drop it.
-- ============================================================================

-- ------------------------------------------------ bookings: guest count ----
-- Null on bookings logged in the app, which do not ask for it.

alter table public.bookings add column if not exists guests_count smallint;

do $$ begin
  alter table public.bookings
    add constraint bookings_guests_count_positive check (guests_count is null or guests_count >= 1);
exception when duplicate_object then null; end $$;

-- --------------------------------------------------- creating a hold ----
-- As create_public_hold() in 0018, with the booking details added. Every
-- check and the insert still run in one transaction; failures are raised as
-- 'oikoz:<code>' for the Edge Function to translate. New codes:
--
--   invalid_details  name not 2-80 characters, unknown client type, guests
--                    missing or below 1, or a note over 300 characters
--   too_many_guests  more guests than the villa's capacity -- or than 30 when
--                    the owner has not set a capacity
--
-- The details are checked after the dates and before the advisory lock, so a
-- bad form never waits on, or counts toward, the two-hold limit.

create or replace function public.create_public_hold(
  p_client_user_id uuid,
  p_villa_code     text,
  p_check_in       date,
  p_check_out      date,
  p_client_name    text,
  p_guests         integer,
  p_client_type    text,
  p_note           text
)
returns public.bookings
language plpgsql security definer set search_path = public as $$
declare
  default_guest_cap constant integer := 30;
  v        public.villas%rowtype;
  visitor  public.users%rowtype;
  makler   uuid;
  today    date := (now() at time zone 'Asia/Tashkent')::date;
  v_name   text := trim(coalesce(p_client_name, ''));
  v_note   text := nullif(trim(coalesce(p_note, '')), '');
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

  if char_length(v_name) < 2
     or char_length(v_name) > 80
     or p_client_type is null
     or not (p_client_type = any (enum_range(null::public.client_type)::text[]))
     or p_guests is null
     or p_guests < 1
     or char_length(coalesce(v_note, '')) > 300
  then
    raise exception 'oikoz:invalid_details';
  end if;

  if p_guests > coalesce(v.capacity, default_guest_cap) then
    raise exception 'oikoz:too_many_guests';
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
  select u.id into makler
    from public.users u
   where u.id = v.default_channel_makler_id
     and u.is_makler;

  begin
    insert into public.bookings (
      villa_id, manager_id, client_user_id, client_name, client_phone,
      client_type, guests_count, notes,
      check_in, check_out, total_price, currency, deposit_amount, pricing_mode,
      status, hold_expires_at
    ) values (
      v.id, makler, visitor.id, v_name, visitor.phone,
      p_client_type::public.client_type, p_guests, v_note,
      p_check_in, p_check_out, total, lower(v.currency)::booking_currency, v.deposit_amount, 'percentage',
      'pending', now() + interval '30 minutes'
    )
    returning * into created;
  exception when exclusion_violation then
    raise exception 'oikoz:dates_taken';
  end;

  return created;
end $$;

revoke all on function public.create_public_hold(uuid, text, date, date, text, integer, text, text) from public;
revoke all on function public.create_public_hold(uuid, text, date, date, text, integer, text, text) from anon;
revoke all on function public.create_public_hold(uuid, text, date, date, text, integer, text, text) from authenticated;
grant execute on function public.create_public_hold(uuid, text, date, date, text, integer, text, text) to service_role;
