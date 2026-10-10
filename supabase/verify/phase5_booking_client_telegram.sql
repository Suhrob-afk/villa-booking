-- ============================================================================
-- Booking card verification -- run AFTER migration 0022.
--
-- Paste the whole file into the SQL Editor and run it once.
--
--   * Every check raises an error starting "FAIL:" the moment it fails, so a
--     failure cannot be missed: the script stops there.
--   * If everything passes, the last result is a single row saying so.
--   * It is wrapped in BEGIN ... ROLLBACK and leaves nothing behind. Fixtures
--     use explicit oikoz_id / villa_code values, so not even the code
--     sequences advance.
-- ============================================================================

begin;

-- ------------------------------------------------------ prerequisites ----
do $$ begin
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'users' and column_name = 'telegram_username'
  ) then
    raise exception 'FAIL 0a: users.telegram_username is missing -- run 0022';
  end if;
  if to_regprocedure('public.villa_booking_clients(uuid)') is null then
    raise exception 'FAIL 0b: villa_booking_clients() is missing -- run 0022';
  end if;
  raise notice 'PASS 0: 0022 applied';
end $$;

-- ------------------------------------------------------------- fixtures ----
-- owner     a...41  owns the villa
-- makler    a...42  assigned to the villa
-- guest     a...43  booked through the public page; has a Telegram username
-- stranger  a...44  owns a different villa, nothing to do with this one
-- noname    a...45  booked through the public page; no Telegram username

insert into public.users (id, telegram_id, name, oikoz_id, phone, is_owner, is_makler, telegram_username) values
  ('a0000000-0000-4000-8000-000000000041', -900000041, 'P5 Owner',    'oikoz_test41', '+998900000041', true,  false, null),
  ('a0000000-0000-4000-8000-000000000042', -900000042, 'P5 Makler',   'oikoz_test42', '+998900000042', false, true,  null),
  ('a0000000-0000-4000-8000-000000000043', -900000043, 'Guest On TG', 'oikoz_test43', '+998900000043', false, false, 'guest43'),
  ('a0000000-0000-4000-8000-000000000044', -900000044, 'P5 Stranger', 'oikoz_test44', '+998900000044', true,  false, null),
  ('a0000000-0000-4000-8000-000000000045', -900000045, 'No Username', 'oikoz_test45', '+998900000045', false, false, null);

insert into public.villas (id, owner_id, name, currency, villa_code, weekday_price, weekend_price,
                           commission_rate, deposit_amount, capacity) values
  ('b0000000-0000-4000-8000-000000000041', 'a0000000-0000-4000-8000-000000000041',
   'P5 Villa', 'UZS', 'villa_test41', 1000000, 1500000, 0.10, 300000, 8);

insert into public.villa_managers (villa_id, manager_id) values
  ('b0000000-0000-4000-8000-000000000041', 'a0000000-0000-4000-8000-000000000042');

insert into public.villa_payout_details (villa_id, card_number) values
  ('b0000000-0000-4000-8000-000000000041', '8600123412341234');

-- Two public holds and one booking the owner logged by hand.
do $$
declare base date := (now() at time zone 'Asia/Tashkent')::date + 40;
begin
  perform public.create_public_hold('a0000000-0000-4000-8000-000000000043', 'villa_test41',
                                    base, base + 2, 'Typed Name', 2, 'couple', null);
  perform public.create_public_hold('a0000000-0000-4000-8000-000000000045', 'villa_test41',
                                    base + 5, base + 6, 'Another', 1, 'business', null);
  insert into public.bookings (villa_id, client_name, check_in, check_out, total_price, status)
  values ('b0000000-0000-4000-8000-000000000041', 'Phone Booking', base + 10, base + 12, 2000000, 'confirmed');
end $$;

-- ======================================================== as the OWNER ----
select set_config('request.jwt.claims',
  '{"sub":"a0000000-0000-4000-8000-000000000041","role":"authenticated"}', true);
set local role authenticated;

do $$
declare
  n int;
  r record;
begin
  -- Only the two public bookings: the hand-logged one has no guest account.
  select count(*) into n from public.villa_booking_clients('b0000000-0000-4000-8000-000000000041');
  if n <> 2 then raise exception 'FAIL 1a: owner got % rows, expected 2', n; end if;

  select c.* into r
    from public.villa_booking_clients('b0000000-0000-4000-8000-000000000041') c
    join public.bookings b on b.id = c.booking_id
   where b.client_user_id = 'a0000000-0000-4000-8000-000000000043';
  if r.telegram_name <> 'Guest On TG' or r.telegram_username <> 'guest43' then
    raise exception 'FAIL 1b: owner got name "%" / username "%"', r.telegram_name, r.telegram_username;
  end if;

  select c.* into r
    from public.villa_booking_clients('b0000000-0000-4000-8000-000000000041') c
    join public.bookings b on b.id = c.booking_id
   where b.client_user_id = 'a0000000-0000-4000-8000-000000000045';
  if r.telegram_name <> 'No Username' or r.telegram_username is not null then
    raise exception 'FAIL 1c: no-username guest came back as "%" / "%"', r.telegram_name, r.telegram_username;
  end if;

  -- The owner still cannot read the guest's users row directly.
  select count(*) into n from public.users where id = 'a0000000-0000-4000-8000-000000000043';
  if n <> 0 then raise exception 'FAIL 1d: the owner can read the guest''s whole users row'; end if;

  raise notice 'PASS 1: the owner sees each public guest''s Telegram name and username, and nothing more';
end $$;

reset role;

-- ================================================ as the assigned MAKLER ----
select set_config('request.jwt.claims',
  '{"sub":"a0000000-0000-4000-8000-000000000042","role":"authenticated"}', true);
set local role authenticated;

do $$
declare n int;
begin
  select count(*) into n from public.villa_booking_clients('b0000000-0000-4000-8000-000000000041');
  if n <> 2 then raise exception 'FAIL 2: assigned makler got % rows, expected 2', n; end if;
  raise notice 'PASS 2: a makler assigned to the villa sees the same';
end $$;

reset role;

-- ====================================================== as a STRANGER ----
select set_config('request.jwt.claims',
  '{"sub":"a0000000-0000-4000-8000-000000000044","role":"authenticated"}', true);
set local role authenticated;

do $$
declare n int;
begin
  select count(*) into n from public.villa_booking_clients('b0000000-0000-4000-8000-000000000041');
  if n <> 0 then raise exception 'FAIL 3: an unrelated owner got % rows', n; end if;
  raise notice 'PASS 3: an owner of another villa gets nothing';
end $$;

reset role;

-- ================================================ as the GUEST themselves ----
select set_config('request.jwt.claims',
  '{"sub":"a0000000-0000-4000-8000-000000000043","role":"authenticated"}', true);
set local role authenticated;

do $$
declare n int;
begin
  select count(*) into n from public.villa_booking_clients('b0000000-0000-4000-8000-000000000041');
  if n <> 0 then raise exception 'FAIL 4a: the guest got % rows of the villa''s client list', n; end if;

  -- Their own username comes from Telegram only.
  begin
    update public.users set telegram_username = 'someone_else'
     where id = 'a0000000-0000-4000-8000-000000000043';
    raise exception 'FAIL 4b: a user changed their own telegram_username';
  exception when raise_exception then
    if sqlerrm like 'FAIL%' then raise; end if;
  end;

  -- What a user may change still works.
  update public.users set name = 'Guest Renamed' where id = 'a0000000-0000-4000-8000-000000000043';
  if not found then raise exception 'FAIL 4c: a user could no longer change their own name'; end if;

  raise notice 'PASS 4: a guest sees no client list and cannot set their own username';
end $$;

reset role;

select 'Booking card verification: all checks passed (everything is rolled back next)' as result;

rollback;
