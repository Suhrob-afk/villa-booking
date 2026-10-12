-- ============================================================================
-- Subscriptions verification -- run AFTER migration 0024.
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
-- App users are impersonated the way PostgREST does it: SET ROLE
-- authenticated plus request.jwt.claims carrying their id as `sub`. After
-- each such section the claims are cleared again, because server-side code
-- (the bot, the Edge Functions) carries no user -- and that is exactly what
-- lets it through the subscription guards.
--
-- now() is frozen for the whole transaction, so "30 days from now" below is
-- 30 days from when this script started.
-- ============================================================================

begin;

-- ------------------------------------------------------ prerequisites ----
do $$ begin
  if to_regclass('public.subscriptions') is null or to_regclass('public.subscription_payments') is null then
    raise exception 'FAIL 0a: subscription tables are missing -- run 0024';
  end if;
  if to_regprocedure('public.mark_subscription_paid(uuid, uuid, text)') is null
     or to_regprocedure('public.has_active_subscription(uuid)') is null then
    raise exception 'FAIL 0b: subscription functions are missing -- run 0024';
  end if;
  if not exists (select 1 from storage.buckets where id = 'receipts' and public = false) then
    raise exception 'FAIL 0c: the receipts bucket is missing or public';
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname = 'receipts_select_own') then
    raise exception 'FAIL 0d: receipts read policy is missing';
  end if;
  raise notice 'PASS 0: 0024 applied, receipts bucket private';
end $$;

-- ------------------------------------------------------------- fixtures ----
-- active   a...81  owner, paid 10 days ahead          villa_test81
-- lapsed   a...82  owner, paid until 4 days ago       villa_test82
-- grace    a...83  owner, paid until 2 days ago       villa_test83
-- never    a...84  owner, never paid
-- makler   a...85  makler linked to the lapsed villa AND the active villa
-- both     a...86  owner AND makler, never paid, linked to the active villa
-- guest    a...87  bare client with a phone
-- makler2  a...88  makler not linked to anything yet

insert into public.users (id, telegram_id, name, oikoz_id, phone, is_owner, is_makler) values
  ('a0000000-0000-4000-8000-000000000081', -900000081, 'P8 Active',  'oikoz_test81', '+998900000081', true,  false),
  ('a0000000-0000-4000-8000-000000000082', -900000082, 'P8 Lapsed',  'oikoz_test82', '+998900000082', true,  false),
  ('a0000000-0000-4000-8000-000000000083', -900000083, 'P8 Grace',   'oikoz_test83', '+998900000083', true,  false),
  ('a0000000-0000-4000-8000-000000000084', -900000084, 'P8 Never',   'oikoz_test84', '+998900000084', true,  false),
  ('a0000000-0000-4000-8000-000000000085', -900000085, 'P8 Makler',  'oikoz_test85', '+998900000085', false, true),
  ('a0000000-0000-4000-8000-000000000086', -900000086, 'P8 Both',    'oikoz_test86', '+998900000086', true,  true),
  ('a0000000-0000-4000-8000-000000000087', -900000087, 'P8 Guest',   'oikoz_test87', '+998900000087', false, false),
  ('a0000000-0000-4000-8000-000000000088', -900000088, 'P8 Makler2', 'oikoz_test88', '+998900000088', false, true);

-- Inserted as the SQL Editor (no user), so the guards let the fixtures in.
insert into public.villas (id, owner_id, name, currency, villa_code, weekday_price, weekend_price) values
  ('b0000000-0000-4000-8000-000000000081', 'a0000000-0000-4000-8000-000000000081', 'P8 Active Villa', 'UZS', 'villa_test81', 1000000, 1500000),
  ('b0000000-0000-4000-8000-000000000082', 'a0000000-0000-4000-8000-000000000082', 'P8 Lapsed Villa', 'UZS', 'villa_test82', 1000000, 1500000),
  ('b0000000-0000-4000-8000-000000000083', 'a0000000-0000-4000-8000-000000000083', 'P8 Grace Villa',  'UZS', 'villa_test83', 1000000, 1500000);

insert into public.villa_payout_details (villa_id, card_number) values
  ('b0000000-0000-4000-8000-000000000081', '8600123412341234'),
  ('b0000000-0000-4000-8000-000000000082', '8600123412341234'),
  ('b0000000-0000-4000-8000-000000000083', '8600123412341234');

insert into public.villa_managers (villa_id, manager_id) values
  ('b0000000-0000-4000-8000-000000000082', 'a0000000-0000-4000-8000-000000000085'),
  ('b0000000-0000-4000-8000-000000000081', 'a0000000-0000-4000-8000-000000000085'),
  ('b0000000-0000-4000-8000-000000000081', 'a0000000-0000-4000-8000-000000000086');

-- The lapsed owner starts out paid, so a guest can hold dates on their villa
-- (and mark the deposit sent) before the subscription runs out below.
insert into public.subscriptions (user_id, paid_until) values
  ('a0000000-0000-4000-8000-000000000081', now() + interval '10 days'),
  ('a0000000-0000-4000-8000-000000000082', now() + interval '10 days'),
  ('a0000000-0000-4000-8000-000000000083', now() - interval '2 days');

-- Dates relative to today in Tashkent: create_public_hold() refuses the past.
create temporary table p8 on commit drop as
select (now() at time zone 'Asia/Tashkent')::date + 40 as d;

-- H: a guest's hold on the lapsed villa, marked paid while the owner was paid.
create temporary table p8_hold (id uuid) on commit drop;

do $$
declare
  d date := (select d from p8);
  h public.bookings%rowtype;
begin
  h := public.create_public_hold('a0000000-0000-4000-8000-000000000087', 'villa_test82', d, d + 2, 'P8 Guest', 2, 'family', null);
  perform public.mark_public_hold_paid('a0000000-0000-4000-8000-000000000087', h.id);
  insert into p8_hold values (h.id);
end $$;

-- A confirmed booking on the lapsed villa, for the owner to (fail to) edit.
insert into public.bookings (id, villa_id, client_name, check_in, check_out, total_price) values
  ('c0000000-0000-4000-8000-000000000081', 'b0000000-0000-4000-8000-000000000082', 'Walk-in',
   (select d from p8) + 10, (select d from p8) + 12, 2000000);

-- Now the lapsed owner lapses: past paid_until AND past the 3-day grace.
update public.subscriptions set paid_until = now() - interval '4 days'
 where user_id = 'a0000000-0000-4000-8000-000000000082';

-- --------------------------------------------------- 1. who is active ----
do $$ begin
  if not public.has_active_subscription('a0000000-0000-4000-8000-000000000081') then
    raise exception 'FAIL 1a: a paid owner is not active';
  end if;
  if not public.has_active_subscription('a0000000-0000-4000-8000-000000000083') then
    raise exception 'FAIL 1b: an owner 2 days past paid_until is not in grace';
  end if;
  if public.has_active_subscription('a0000000-0000-4000-8000-000000000082') then
    raise exception 'FAIL 1c: an owner 4 days past paid_until is still active';
  end if;
  if public.has_active_subscription('a0000000-0000-4000-8000-000000000084') then
    raise exception 'FAIL 1d: an owner who never paid is active';
  end if;
  raise notice 'PASS 1: active, 3-day grace, lapsed and never-paid all read correctly';
end $$;

-- ================================================= as the LAPSED OWNER ----
select set_config('request.jwt.claims',
  '{"sub":"a0000000-0000-4000-8000-000000000082","role":"authenticated"}', true);
set local role authenticated;

do $$
declare
  d date := (select (now() at time zone 'Asia/Tashkent')::date + 100);
  n int;
begin
  -- Everything stays readable.
  select count(*) into n from public.villas where id = 'b0000000-0000-4000-8000-000000000082';
  if n <> 1 then raise exception 'FAIL 2a: a lapsed owner cannot see their villa'; end if;
  select count(*) into n from public.bookings where villa_id = 'b0000000-0000-4000-8000-000000000082';
  if n < 2 then raise exception 'FAIL 2b: a lapsed owner cannot see their bookings (saw %)', n; end if;

  begin
    insert into public.villas (owner_id, name, currency, villa_code)
    values ('a0000000-0000-4000-8000-000000000082', 'New', 'UZS', 'villa_test89');
    raise exception 'FAIL 2c: a lapsed owner created a villa';
  exception when others then
    if sqlerrm not like 'oikoz:subscription_required%' then raise exception 'FAIL 2c: expected subscription_required, got %', sqlerrm; end if;
  end;

  begin
    update public.villas set name = 'Renamed' where id = 'b0000000-0000-4000-8000-000000000082';
    raise exception 'FAIL 2d: a lapsed owner edited their villa';
  exception when others then
    if sqlerrm not like 'oikoz:villa_owner_inactive%' then raise exception 'FAIL 2d: expected villa_owner_inactive, got %', sqlerrm; end if;
  end;

  begin
    update public.villa_payout_details set card_number = '8600000000000000' where villa_id = 'b0000000-0000-4000-8000-000000000082';
    raise exception 'FAIL 2e: a lapsed owner changed their payout card';
  exception when others then
    if sqlerrm not like 'oikoz:villa_owner_inactive%' then raise exception 'FAIL 2e: expected villa_owner_inactive, got %', sqlerrm; end if;
  end;

  begin
    insert into public.blocked_dates (villa_id, start_date, end_date, reason, created_by)
    values ('b0000000-0000-4000-8000-000000000082', d, d + 1, 'maintenance', 'a0000000-0000-4000-8000-000000000082');
    raise exception 'FAIL 2f: a lapsed owner blocked dates';
  exception when others then
    if sqlerrm not like 'oikoz:villa_owner_inactive%' then raise exception 'FAIL 2f: expected villa_owner_inactive, got %', sqlerrm; end if;
  end;

  begin
    insert into public.bookings (villa_id, client_name, check_in, check_out, total_price)
    values ('b0000000-0000-4000-8000-000000000082', 'Owner-logged', d + 5, d + 6, 1000000);
    raise exception 'FAIL 2g: a lapsed owner logged a booking';
  exception when others then
    if sqlerrm not like 'oikoz:villa_owner_inactive%' then raise exception 'FAIL 2g: expected villa_owner_inactive, got %', sqlerrm; end if;
  end;

  begin
    update public.bookings set status = 'cancelled' where id = 'c0000000-0000-4000-8000-000000000081';
    raise exception 'FAIL 2h: a lapsed owner cancelled a booking';
  exception when others then
    if sqlerrm not like 'oikoz:villa_owner_inactive%' then raise exception 'FAIL 2h: expected villa_owner_inactive, got %', sqlerrm; end if;
  end;

  -- Through a SECURITY DEFINER function too: the guard reads auth.uid().
  begin
    perform public.link_manager_by_oikoz_id('b0000000-0000-4000-8000-000000000082', 'oikoz_test88');
    raise exception 'FAIL 2i: a lapsed owner linked a makler';
  exception when others then
    if sqlerrm not like 'oikoz:villa_owner_inactive%' then raise exception 'FAIL 2i: expected villa_owner_inactive, got %', sqlerrm; end if;
  end;

  -- Their own profile is not villa data and stays editable.
  update public.users set language = 'ru' where id = 'a0000000-0000-4000-8000-000000000082';

  raise notice 'PASS 2: a lapsed owner reads everything and changes no villa, booking, block, card or makler';
end $$;

reset role;
select set_config('request.jwt.claims', '', true);

-- ================================================== as the GRACE OWNER ----
select set_config('request.jwt.claims',
  '{"sub":"a0000000-0000-4000-8000-000000000083","role":"authenticated"}', true);
set local role authenticated;

do $$
declare d date := (select (now() at time zone 'Asia/Tashkent')::date + 100);
begin
  insert into public.blocked_dates (villa_id, start_date, end_date, reason, created_by)
  values ('b0000000-0000-4000-8000-000000000083', d, d + 1, 'maintenance', 'a0000000-0000-4000-8000-000000000083');
  update public.villas set name = 'P8 Grace Villa (edited)' where id = 'b0000000-0000-4000-8000-000000000083';
  raise notice 'PASS 3: an owner within the 3-day grace can still write';
exception when others then
  raise exception 'FAIL 3: an owner in grace was refused: %', sqlerrm;
end $$;

reset role;
select set_config('request.jwt.claims', '', true);

-- =================================================== as the MAKLER ----
-- The gate follows the villa's owner: a makler is never charged, but works
-- only on villas whose owner is paid.
select set_config('request.jwt.claims',
  '{"sub":"a0000000-0000-4000-8000-000000000085","role":"authenticated"}', true);
set local role authenticated;

do $$
declare d date := (select (now() at time zone 'Asia/Tashkent')::date + 100);
begin
  begin
    insert into public.bookings (villa_id, manager_id, client_name, check_in, check_out, total_price)
    values ('b0000000-0000-4000-8000-000000000081', 'a0000000-0000-4000-8000-000000000085', 'Makler client', d + 20, d + 22, 2000000);
  exception when others then
    raise exception 'FAIL 4a: a makler was refused on a paid owner''s villa: %', sqlerrm;
  end;

  begin
    insert into public.bookings (villa_id, manager_id, client_name, check_in, check_out, total_price)
    values ('b0000000-0000-4000-8000-000000000082', 'a0000000-0000-4000-8000-000000000085', 'Makler client', d + 20, d + 22, 2000000);
    raise exception 'FAIL 4b: a makler logged a booking on a lapsed owner''s villa';
  exception when others then
    if sqlerrm not like 'oikoz:villa_owner_inactive%' then raise exception 'FAIL 4b: expected villa_owner_inactive, got %', sqlerrm; end if;
  end;
  raise notice 'PASS 4: a makler works on a paid owner''s villa and is read-only on a lapsed one';
end $$;

reset role;
select set_config('request.jwt.claims', '', true);

-- ========================================= as an OWNER who is also a MAKLER ----
select set_config('request.jwt.claims',
  '{"sub":"a0000000-0000-4000-8000-000000000086","role":"authenticated"}', true);
set local role authenticated;

do $$
declare d date := (select (now() at time zone 'Asia/Tashkent')::date + 100);
begin
  -- Working on a paid owner's villa: allowed, though they pay for nothing.
  insert into public.bookings (villa_id, manager_id, client_name, check_in, check_out, total_price)
  values ('b0000000-0000-4000-8000-000000000081', 'a0000000-0000-4000-8000-000000000086', 'Both client', d + 30, d + 32, 2000000);

  -- Creating a villa of their own: needs THEIR subscription, flags aside.
  begin
    insert into public.villas (owner_id, name, currency, villa_code)
    values ('a0000000-0000-4000-8000-000000000086', 'Mine', 'UZS', 'villa_test86');
    raise exception 'FAIL 5: an unpaid owner-and-makler created a villa';
  exception when others then
    if sqlerrm not like 'oikoz:subscription_required%' then raise exception 'FAIL 5: expected subscription_required, got %', sqlerrm; end if;
  end;
  raise notice 'PASS 5: owner-and-makler is judged by the villa they touch, and pays to create one';
end $$;

reset role;
select set_config('request.jwt.claims', '', true);

-- ==================================================== as the PAID OWNER ----
select set_config('request.jwt.claims',
  '{"sub":"a0000000-0000-4000-8000-000000000081","role":"authenticated"}', true);
set local role authenticated;

do $$ begin
  insert into public.villas (owner_id, name, currency, villa_code)
  values ('a0000000-0000-4000-8000-000000000081', 'Second', 'UZS', 'villa_test89');
  update public.villas set name = 'P8 Active Villa (edited)' where id = 'b0000000-0000-4000-8000-000000000081';
  raise notice 'PASS 5b: a paid owner creates and edits villas';
exception when others then
  raise exception 'FAIL 5b: a paid owner was refused: %', sqlerrm;
end $$;

reset role;
select set_config('request.jwt.claims', '', true);

-- ================================================= the public page ----
do $$
declare d date := (select d from p8);
begin
  begin
    perform public.create_public_hold('a0000000-0000-4000-8000-000000000087', 'villa_test82', d + 50, d + 52, 'P8 Guest', 2, 'family', null);
    raise exception 'FAIL 6a: a lapsed owner''s villa took a new hold';
  exception when others then
    if sqlerrm not like 'oikoz:bookings_paused%' then raise exception 'FAIL 6a: expected bookings_paused, got %', sqlerrm; end if;
  end;

  perform public.create_public_hold('a0000000-0000-4000-8000-000000000087', 'villa_test83', d + 50, d + 52, 'P8 Guest', 2, 'family', null);
  raise notice 'PASS 6: new holds pause on a lapsed villa and keep working in grace';
end $$;

-- The hold made before the lapse is still confirmable by the owner's bot button.
do $$
declare r jsonb;
begin
  r := public.confirm_public_hold(-900000082, (select id from p8_hold), false);
  if r->>'outcome' <> 'confirmed' then
    raise exception 'FAIL 7: confirming an existing hold on a lapsed villa gave %', r;
  end if;
  raise notice 'PASS 7: existing holds stay workable after the owner lapses';
end $$;

-- ===================================================== granting time ----
insert into public.subscription_payments (id, user_id, amount) values
  ('d0000000-0000-4000-8000-000000000081', 'a0000000-0000-4000-8000-000000000084', 49000);

do $$
declare r jsonb;
begin
  -- Never paid: 30 days from now.
  r := public.mark_subscription_paid('d0000000-0000-4000-8000-000000000081', 'a0000000-0000-4000-8000-000000000084', 'telegram:1');
  if r->>'outcome' <> 'confirmed' or (r->>'paid_until')::timestamptz <> now() + interval '30 days' then
    raise exception 'FAIL 8a: first payment gave %', r;
  end if;
  if (select status from public.subscription_payments where id = 'd0000000-0000-4000-8000-000000000081') <> 'confirmed'
     or (select confirmed_by from public.subscription_payments where id = 'd0000000-0000-4000-8000-000000000081') <> 'telegram:1' then
    raise exception 'FAIL 8b: the payment was not marked confirmed by telegram:1';
  end if;

  -- A double tap grants nothing more.
  r := public.mark_subscription_paid('d0000000-0000-4000-8000-000000000081', 'a0000000-0000-4000-8000-000000000084', 'telegram:1');
  if r->>'outcome' <> 'already_handled' or (r->>'paid_until')::timestamptz <> now() + interval '30 days' then
    raise exception 'FAIL 8c: a repeated confirm gave %', r;
  end if;

  -- Rejecting an already-confirmed payment changes nothing.
  r := public.reject_subscription_payment('d0000000-0000-4000-8000-000000000081', 'a0000000-0000-4000-8000-000000000084', 'telegram:1');
  if r->>'outcome' <> 'already_handled' or r->>'status' <> 'confirmed' then
    raise exception 'FAIL 8d: rejecting a confirmed payment gave %', r;
  end if;
  raise notice 'PASS 8: a first payment grants 30 days, once';
end $$;

-- A second payment while still paid EXTENDS rather than resets.
insert into public.subscription_payments (id, user_id, amount) values
  ('d0000000-0000-4000-8000-000000000082', 'a0000000-0000-4000-8000-000000000084', 49000);

do $$
declare r jsonb;
begin
  r := public.mark_subscription_paid('d0000000-0000-4000-8000-000000000082', 'a0000000-0000-4000-8000-000000000084', 'telegram:1');
  if (r->>'paid_until')::timestamptz <> now() + interval '60 days' then
    raise exception 'FAIL 9: a second payment gave %, expected now() + 60 days', r->>'paid_until';
  end if;
  raise notice 'PASS 9: paying again while active adds 30 days on top';
end $$;

-- Paying after paid_until has passed (even within grace) starts from now.
insert into public.subscription_payments (id, user_id, amount) values
  ('d0000000-0000-4000-8000-000000000083', 'a0000000-0000-4000-8000-000000000083', 49000);

do $$
declare r jsonb;
begin
  r := public.mark_subscription_paid('d0000000-0000-4000-8000-000000000083', 'a0000000-0000-4000-8000-000000000083', 'telegram:1');
  if (r->>'paid_until')::timestamptz <> now() + interval '30 days' then
    raise exception 'FAIL 10: renewing after paid_until gave %, expected now() + 30 days', r->>'paid_until';
  end if;
  raise notice 'PASS 10: renewing after paid_until starts 30 days from now';
end $$;

-- Wrong user, rejection, and one pending receipt at a time.
insert into public.subscription_payments (id, user_id, amount) values
  ('d0000000-0000-4000-8000-000000000084', 'a0000000-0000-4000-8000-000000000081', 49000);

do $$
declare r jsonb;
begin
  r := public.mark_subscription_paid('d0000000-0000-4000-8000-000000000084', 'a0000000-0000-4000-8000-000000000084', 'telegram:1');
  if r->>'outcome' <> 'not_found' then raise exception 'FAIL 11a: confirming another user''s payment gave %', r; end if;

  r := public.reject_subscription_payment('d0000000-0000-4000-8000-000000000084', 'a0000000-0000-4000-8000-000000000081', 'telegram:1');
  if r->>'outcome' <> 'rejected' then raise exception 'FAIL 11b: rejecting gave %', r; end if;
  if (select paid_until from public.subscriptions where user_id = 'a0000000-0000-4000-8000-000000000081') <> now() + interval '10 days' then
    raise exception 'FAIL 11c: a rejection changed paid_until';
  end if;

  insert into public.subscription_payments (user_id, amount) values ('a0000000-0000-4000-8000-000000000081', 49000);
  begin
    insert into public.subscription_payments (user_id, amount) values ('a0000000-0000-4000-8000-000000000081', 49000);
    raise exception 'FAIL 11d: a second pending payment was accepted';
  exception when unique_violation then
    null;
  end;
  raise notice 'PASS 11: wrong user refused, rejection grants nothing, one pending receipt per user';
end $$;

-- ========================================== as the user: read own only ----
select set_config('request.jwt.claims',
  '{"sub":"a0000000-0000-4000-8000-000000000084","role":"authenticated"}', true);
set local role authenticated;

do $$
declare n int;
begin
  select count(*) into n from public.subscriptions;
  if n <> 1 then raise exception 'FAIL 12a: a user sees % subscription rows, expected their own 1', n; end if;
  select count(*) into n from public.subscription_payments;
  if n <> 2 then raise exception 'FAIL 12b: a user sees % payments, expected their own 2', n; end if;
  if not public.has_active_subscription('a0000000-0000-4000-8000-000000000084') then
    raise exception 'FAIL 12c: has_active_subscription() is not callable or wrong for the user';
  end if;

  begin
    insert into public.subscription_payments (user_id, amount, status) values ('a0000000-0000-4000-8000-000000000084', 0, 'confirmed');
    raise exception 'FAIL 12d: a user inserted a payment';
  exception when insufficient_privilege then null;
  end;

  begin
    update public.subscription_payments set status = 'confirmed';
    raise exception 'FAIL 12e: a user updated a payment status';
  exception when insufficient_privilege then null;
  end;

  begin
    update public.subscriptions set paid_until = now() + interval '1 year';
    raise exception 'FAIL 12f: a user extended their own subscription';
  exception when insufficient_privilege then null;
  end;

  begin
    perform public.mark_subscription_paid('d0000000-0000-4000-8000-000000000081', 'a0000000-0000-4000-8000-000000000084', 'me');
    raise exception 'FAIL 12g: a user called mark_subscription_paid()';
  exception when insufficient_privilege then null;
  end;

  begin
    perform public.grant_subscription_time('a0000000-0000-4000-8000-000000000084');
    raise exception 'FAIL 12h: a user called grant_subscription_time()';
  exception when insufficient_privilege then null;
  end;

  raise notice 'PASS 12: a user reads only their own rows and can grant nothing';
end $$;

reset role;
select set_config('request.jwt.claims', '', true);

select 'Subscriptions verification: all checks passed (everything is rolled back next)' as result;

rollback;
