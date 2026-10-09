-- ============================================================================
-- Phase 2 verification -- run AFTER migration 0018.
--
-- Paste the whole file into the SQL Editor and run it once.
--
--   * Every check raises an error starting "FAIL:" the moment it fails, so a
--     failure cannot be missed: the script stops there.
--   * If everything passes, the last result is a single row saying so.
--   * It is wrapped in BEGIN ... ROLLBACK and leaves nothing behind. Fixtures
--     use explicit oikoz_id / villa_code values, so not even the code
--     sequences advance.
--
-- Dates are relative to today in Tashkent, because create_public_hold()
-- refuses past check-ins and anything over a year out.
--
-- Note: now() is frozen for a whole transaction, so "two hours from now"
-- below means two hours from when this script started.
-- ============================================================================

begin;

-- ------------------------------------------------------ prerequisites ----
do $$ begin
  if not exists (select 1 from pg_extension where extname = 'pg_cron') then
    raise exception 'FAIL 0a: pg_cron is not enabled';
  end if;
  if not exists (select 1 from cron.job where jobname = 'oikoz-release-expired-holds') then
    raise exception 'FAIL 0b: the hold cleanup job from 0017 is not scheduled';
  end if;
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'bookings' and column_name = 'client_user_id'
  ) then
    raise exception 'FAIL 0c: bookings.client_user_id is missing -- run 0018 first';
  end if;
  raise notice 'PASS 0: pg_cron job present and 0018 applied';
end $$;

-- ------------------------------------------------------------- fixtures ----
-- owner    a...11  owns both test villas
-- channel  a...12  makler, the villa's default channel makler
-- guest    a...13  bare client WITH a phone
-- nophone  a...14  bare client without a phone
-- rival    a...15  bare client with a phone, racing the guest for dates
--
-- villa    b...11  takes bookings: has a payout card. UZS, 1,000,000 weekday,
--                  1,500,000 weekend, 10% commission, channel makler set.
-- nocard   b...12  has no payout card yet

insert into public.users (id, telegram_id, name, oikoz_id, phone, is_owner, is_makler) values
  ('a0000000-0000-4000-8000-000000000011', -900000011, 'P2 Owner',   'oikoz_test11', '+998900000011', true,  false),
  ('a0000000-0000-4000-8000-000000000012', -900000012, 'P2 Channel', 'oikoz_test12', '+998900000012', false, true),
  ('a0000000-0000-4000-8000-000000000013', -900000013, 'P2 Guest',   'oikoz_test13', '+998900000013', false, false),
  ('a0000000-0000-4000-8000-000000000014', -900000014, 'P2 NoPhone', 'oikoz_test14', null,            false, false),
  ('a0000000-0000-4000-8000-000000000015', -900000015, 'P2 Rival',   'oikoz_test15', '+998900000015', false, false);

insert into public.villas (id, owner_id, name, currency, villa_code, weekday_price, weekend_price,
                           commission_rate, deposit_amount, default_channel_makler_id) values
  ('b0000000-0000-4000-8000-000000000011', 'a0000000-0000-4000-8000-000000000011',
   'P2 Villa', 'UZS', 'villa_test11', 1000000, 1500000, 0.10, 300000,
   'a0000000-0000-4000-8000-000000000012'),
  ('b0000000-0000-4000-8000-000000000012', 'a0000000-0000-4000-8000-000000000011',
   'P2 No Card', 'UZS', 'villa_test12', 1000000, 1500000, 0.10, 300000, null);

insert into public.villa_payout_details (villa_id, card_number) values
  ('b0000000-0000-4000-8000-000000000011', '8600123412341234');

-- The Monday at least 30 days out, Tashkent time: a Mon->Mon stay is exactly
-- 5 weekday and 2 weekend nights.
create temporary table p2 on commit drop as
select d as mon
  from (select (now() at time zone 'Asia/Tashkent')::date + 30 as base) b,
       lateral (select b.base + ((8 - extract(isodow from b.base)::int) % 7) as d) m;

-- ======================================================== as an APP USER ----
select set_config('request.jwt.claims',
  '{"sub":"a0000000-0000-4000-8000-000000000011","role":"authenticated"}', true);
set local role authenticated;

do $$ begin
  begin
    perform public.create_public_hold('a0000000-0000-4000-8000-000000000011', 'villa_test11',
                                      current_date + 40, current_date + 42);
  exception when insufficient_privilege then
    raise notice 'PASS 1a: an app user cannot call create_public_hold()';
    return;
  end;
  raise exception 'FAIL 1a: an app user called create_public_hold()';
end $$;

do $$ begin
  begin
    perform public.mark_public_hold_paid('a0000000-0000-4000-8000-000000000011',
                                         'c0000000-0000-4000-8000-000000000099');
  exception when insufficient_privilege then
    raise notice 'PASS 1b: an app user cannot call mark_public_hold_paid()';
    return;
  end;
  raise exception 'FAIL 1b: an app user called mark_public_hold_paid()';
end $$;

-- The owner cannot attach a booking to a visitor themselves.
do $$ begin
  begin
    insert into public.bookings (villa_id, client_name, check_in, check_out, total_price, client_user_id)
    values ('b0000000-0000-4000-8000-000000000011', 'Spoof', current_date + 200, current_date + 201, 1000000,
            'a0000000-0000-4000-8000-000000000013');
  exception when check_violation then
    raise notice 'PASS 1c: an app user cannot set client_user_id';
    return;
  end;
  raise exception 'FAIL 1c: an app user set client_user_id on a booking';
end $$;

reset role;

-- ================================================ as the SERVICE (owner) ----
-- What create-public-booking / mark-deposit-sent do, minus the HTTP.

-- Refusals that need no hold to exist.
do $$
declare mon date := (select mon from p2);
begin
  begin
    perform public.create_public_hold('a0000000-0000-4000-8000-000000000014', 'villa_test11', mon, mon + 2);
    raise exception 'FAIL 2a: a visitor without a phone got a hold';
  exception when others then
    if sqlerrm not like 'oikoz:phone_required%' then raise exception 'FAIL 2a: expected phone_required, got %', sqlerrm; end if;
  end;

  begin
    perform public.create_public_hold('a0000000-0000-4000-8000-000000000013', 'villa_test12', mon, mon + 2);
    raise exception 'FAIL 2b: a villa with no payout card took a hold';
  exception when others then
    if sqlerrm not like 'oikoz:not_accepting%' then raise exception 'FAIL 2b: expected not_accepting, got %', sqlerrm; end if;
  end;

  begin
    perform public.create_public_hold('a0000000-0000-4000-8000-000000000013', 'villa_nope', mon, mon + 2);
    raise exception 'FAIL 2c: an unknown villa code took a hold';
  exception when others then
    if sqlerrm not like 'oikoz:not_found%' then raise exception 'FAIL 2c: expected not_found, got %', sqlerrm; end if;
  end;

  begin  -- yesterday in Tashkent
    perform public.create_public_hold('a0000000-0000-4000-8000-000000000013', 'villa_test11',
      (now() at time zone 'Asia/Tashkent')::date - 1, (now() at time zone 'Asia/Tashkent')::date + 1);
    raise exception 'FAIL 2d: a past check-in was accepted';
  exception when others then
    if sqlerrm not like 'oikoz:invalid_dates%' then raise exception 'FAIL 2d: expected invalid_dates, got %', sqlerrm; end if;
  end;

  begin
    perform public.create_public_hold('a0000000-0000-4000-8000-000000000013', 'villa_test11', mon, mon + 61);
    raise exception 'FAIL 2e: a 61-night stay was accepted';
  exception when others then
    if sqlerrm not like 'oikoz:invalid_dates%' then raise exception 'FAIL 2e: expected invalid_dates, got %', sqlerrm; end if;
  end;

  begin
    perform public.create_public_hold('a0000000-0000-4000-8000-000000000013', 'villa_test11', mon, mon);
    raise exception 'FAIL 2f: an empty range was accepted';
  exception when others then
    if sqlerrm not like 'oikoz:invalid_dates%' then raise exception 'FAIL 2f: expected invalid_dates, got %', sqlerrm; end if;
  end;

  raise notice 'PASS 2: phone, payout card, villa code and date rules all refuse';
end $$;

-- H1: the guest holds Mon -> Mon, 7 nights.
do $$
declare
  mon date := (select mon from p2);
  h public.bookings%rowtype;
begin
  h := public.create_public_hold('a0000000-0000-4000-8000-000000000013', 'villa_test11', mon, mon + 7);

  if h.status <> 'pending' then raise exception 'FAIL 3a: status is %', h.status; end if;
  if h.hold_expires_at <> now() + interval '30 minutes' then
    raise exception 'FAIL 3b: hold_expires_at is %, expected now() + 30 min', h.hold_expires_at;
  end if;
  if h.total_price <> 5 * 1000000 + 2 * 1500000 then
    raise exception 'FAIL 3c: total_price is %, expected 8,000,000 (5 weekday + 2 weekend nights)', h.total_price;
  end if;
  if h.currency <> 'uzs' or h.deposit_amount <> 300000 then
    raise exception 'FAIL 3d: currency % / deposit %, expected uzs / 300000', h.currency, h.deposit_amount;
  end if;
  if h.manager_id is distinct from 'a0000000-0000-4000-8000-000000000012'
     or h.pricing_mode <> 'percentage'
     or h.commission_rate_snapshot <> 0.10
     or h.manager_commission <> 800000
  then
    raise exception 'FAIL 3e: commission wrong: makler %, mode %, rate %, commission %',
      h.manager_id, h.pricing_mode, h.commission_rate_snapshot, h.manager_commission;
  end if;
  if h.client_user_id <> 'a0000000-0000-4000-8000-000000000013'
     or h.client_name <> 'P2 Guest' or h.client_phone <> '+998900000013'
  then
    raise exception 'FAIL 3f: visitor details not copied onto the hold';
  end if;
  if h.deposit_paid or h.client_marked_paid_at is not null then
    raise exception 'FAIL 3g: a new hold is already marked paid';
  end if;
  raise notice 'PASS 3: hold created with server-side price, deposit, 30-minute expiry and channel commission';
end $$;

-- Somebody else racing for overlapping nights hits the overlap constraint.
do $$
declare mon date := (select mon from p2);
begin
  perform public.create_public_hold('a0000000-0000-4000-8000-000000000015', 'villa_test11', mon + 6, mon + 9);
  raise exception 'FAIL 4a: an overlapping hold was accepted';
exception when others then
  if sqlerrm not like 'oikoz:dates_taken%' then raise exception 'FAIL 4a: expected dates_taken, got %', sqlerrm; end if;
  raise notice 'PASS 4a: overlapping dates are refused as dates_taken';
end $$;

-- Half-open: the hold's check-out day is free for the next guest.
do $$
declare mon date := (select mon from p2);
begin
  perform public.create_public_hold('a0000000-0000-4000-8000-000000000015', 'villa_test11', mon + 7, mon + 8);
  raise notice 'PASS 4b: a hold can start on another hold''s check-out day';
exception when others then
  raise exception 'FAIL 4b: back-to-back hold refused: %', sqlerrm;
end $$;

-- An owner block reads as taken, without its reason.
insert into public.blocked_dates (villa_id, start_date, end_date, reason)
select 'b0000000-0000-4000-8000-000000000011', mon + 20, mon + 22, 'maintenance' from p2;

do $$
declare mon date := (select mon from p2);
begin
  perform public.create_public_hold('a0000000-0000-4000-8000-000000000015', 'villa_test11', mon + 19, mon + 21);
  raise exception 'FAIL 4c: a hold over an owner block was accepted';
exception when others then
  if sqlerrm not like 'oikoz:dates_taken%' then raise exception 'FAIL 4c: expected dates_taken, got %', sqlerrm; end if;
  raise notice 'PASS 4c: blocked dates are refused as dates_taken';
end $$;

-- Two live holds per visitor, across villas; the third is refused.
do $$
declare mon date := (select mon from p2);
begin
  perform public.create_public_hold('a0000000-0000-4000-8000-000000000013', 'villa_test11', mon + 30, mon + 31);
  begin
    perform public.create_public_hold('a0000000-0000-4000-8000-000000000013', 'villa_test11', mon + 40, mon + 41);
    raise exception 'FAIL 5: a third live hold was accepted';
  exception when others then
    if sqlerrm not like 'oikoz:too_many_holds%' then raise exception 'FAIL 5: expected too_many_holds, got %', sqlerrm; end if;
  end;
  raise notice 'PASS 5: a visitor is limited to two live holds';
end $$;

-- "I've sent the deposit"
do $$
declare
  mon date := (select mon from p2);
  hold_id uuid;
  n int;
  h public.bookings%rowtype;
begin
  select id into hold_id from public.bookings
   where client_user_id = 'a0000000-0000-4000-8000-000000000013' and check_in = mon;

  -- Somebody else's hold: nothing happens.
  select count(*) into n from public.mark_public_hold_paid('a0000000-0000-4000-8000-000000000015', hold_id);
  if n <> 0 then raise exception 'FAIL 6a: another visitor marked the guest''s hold paid'; end if;

  select * into h from public.mark_public_hold_paid('a0000000-0000-4000-8000-000000000013', hold_id);
  if h.id is null then raise exception 'FAIL 6b: the guest could not mark their own hold paid'; end if;
  if h.client_marked_paid_at is null then raise exception 'FAIL 6c: client_marked_paid_at not set'; end if;
  if h.hold_expires_at <> now() + interval '2 hours' then
    raise exception 'FAIL 6d: hold_expires_at is %, expected now() + 2 hours', h.hold_expires_at;
  end if;
  if h.deposit_paid then raise exception 'FAIL 6e: marking sent set deposit_paid'; end if;
  if h.status <> 'pending' then raise exception 'FAIL 6f: marking sent changed status to %', h.status; end if;

  -- Pretend time passed, then tap again: no second extension.
  update public.bookings set hold_expires_at = now() + interval '10 minutes' where id = hold_id;
  select * into h from public.mark_public_hold_paid('a0000000-0000-4000-8000-000000000013', hold_id);
  if h.hold_expires_at <> now() + interval '10 minutes' then
    raise exception 'FAIL 6g: a repeated tap extended the hold again (now %)', h.hold_expires_at;
  end if;

  -- A lapsed hold cannot be marked.
  update public.bookings set hold_expires_at = now() - interval '1 minute' where id = hold_id;
  select count(*) into n from public.mark_public_hold_paid('a0000000-0000-4000-8000-000000000013', hold_id);
  if n <> 0 then raise exception 'FAIL 6h: a lapsed hold was marked paid'; end if;

  raise notice 'PASS 6: mark-sent is owner-of-hold only, extends once to 2 hours, never sets deposit_paid';
end $$;

-- A lapsed hold no longer counts toward the limit, and frees its nights.
do $$
declare mon date := (select mon from p2);
begin
  perform public.create_public_hold('a0000000-0000-4000-8000-000000000013', 'villa_test11', mon + 1, mon + 3);
  raise notice 'PASS 7: a lapsed hold frees both its nights and the visitor''s hold slot';
exception when others then
  raise exception 'FAIL 7: a lapsed hold still blocked: %', sqlerrm;
end $$;

-- A channel makler who has since dropped is_makler: the hold credits nobody
-- rather than failing for the guest.
update public.users set is_makler = false where id = 'a0000000-0000-4000-8000-000000000012';

do $$
declare
  mon date := (select mon from p2);
  h public.bookings%rowtype;
begin
  h := public.create_public_hold('a0000000-0000-4000-8000-000000000015', 'villa_test11', mon + 50, mon + 51);
  if h.manager_id is not null or h.manager_commission <> 0 then
    raise exception 'FAIL 8: expected no makler and zero commission, got % / %', h.manager_id, h.manager_commission;
  end if;
  raise notice 'PASS 8: a former makler is not credited; the hold still succeeds';
end $$;

-- None of this is revenue or a cancellation.
do $$
declare n int;
begin
  select count(*) into n from public.bookings
   where villa_id = 'b0000000-0000-4000-8000-000000000011' and status in ('confirmed', 'cancelled');
  if n <> 0 then raise exception 'FAIL 9: a public hold became confirmed or cancelled'; end if;
  raise notice 'PASS 9: holds are neither sales nor cancellations';
end $$;

select 'Phase 2 verification: all checks passed (everything is rolled back next)' as result;

rollback;
