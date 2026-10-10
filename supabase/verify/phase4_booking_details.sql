-- ============================================================================
-- Public booking details verification -- run AFTER migration 0021.
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
-- It exercises create_public_hold()'s eight-argument version exactly as
-- create-public-booking calls it, plus the four-argument one left in place
-- for the deploy window.
-- ============================================================================

begin;

-- ------------------------------------------------------ prerequisites ----
do $$ begin
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'bookings' and column_name = 'guests_count'
  ) then
    raise exception 'FAIL 0a: bookings.guests_count is missing -- run 0021';
  end if;
  if to_regprocedure('public.create_public_hold(uuid, text, date, date, text, integer, text, text)') is null then
    raise exception 'FAIL 0b: the eight-argument create_public_hold() is missing -- run 0021';
  end if;
  if to_regprocedure('public.create_public_hold(uuid, text, date, date)') is null then
    raise exception 'FAIL 0c: the four-argument create_public_hold() is gone -- the deployed function still needs it';
  end if;
  raise notice 'PASS 0: 0021 applied, both create_public_hold() versions present';
end $$;

-- ------------------------------------------------------------- fixtures ----
-- owner   a...31  owns both villas
-- guest   a...32  bare client with a phone
-- rival   a...33  bare client with a phone
-- big     a...34  bare client with a phone
-- old     a...35  bare client with a phone, uses the four-argument version
--
-- capped    b...31  capacity 4
-- uncapped  b...32  no capacity set: the cap is 30

insert into public.users (id, telegram_id, name, full_name, oikoz_id, phone, is_owner, is_makler) values
  ('a0000000-0000-4000-8000-000000000031', -900000031, 'P4 Owner', 'P4 Owner', 'oikoz_test31', '+998900000031', true,  false),
  ('a0000000-0000-4000-8000-000000000032', -900000032, 'P4 Guest', 'Profile Name', 'oikoz_test32', '+998900000032', false, false),
  ('a0000000-0000-4000-8000-000000000033', -900000033, 'P4 Rival', 'P4 Rival', 'oikoz_test33', '+998900000033', false, false),
  ('a0000000-0000-4000-8000-000000000034', -900000034, 'P4 Big',   'P4 Big',   'oikoz_test34', '+998900000034', false, false),
  ('a0000000-0000-4000-8000-000000000035', -900000035, 'P4 Old',   'P4 Old',   'oikoz_test35', '+998900000035', false, false);

insert into public.villas (id, owner_id, name, currency, villa_code, weekday_price, weekend_price,
                           commission_rate, deposit_amount, capacity) values
  ('b0000000-0000-4000-8000-000000000031', 'a0000000-0000-4000-8000-000000000031',
   'P4 Capped', 'UZS', 'villa_test31', 1000000, 1500000, 0.10, 300000, 4),
  ('b0000000-0000-4000-8000-000000000032', 'a0000000-0000-4000-8000-000000000031',
   'P4 Uncapped', 'UZS', 'villa_test32', 1000000, 1500000, 0.10, 300000, null);

insert into public.villa_payout_details (villa_id, card_number) values
  ('b0000000-0000-4000-8000-000000000031', '8600123412341234'),
  ('b0000000-0000-4000-8000-000000000032', '8600123412341234');

-- The Monday at least 30 days out, Tashkent time.
create temporary table p4 on commit drop as
select d as mon
  from (select (now() at time zone 'Asia/Tashkent')::date + 30 as base) b,
       lateral (select b.base + ((8 - extract(isodow from b.base)::int) % 7) as d) m;

-- ======================================================== as an APP USER ----
select set_config('request.jwt.claims',
  '{"sub":"a0000000-0000-4000-8000-000000000032","role":"authenticated"}', true);
set local role authenticated;

do $$ begin
  perform public.create_public_hold('a0000000-0000-4000-8000-000000000032', 'villa_test31',
                                    current_date + 40, current_date + 41, 'Me', 2, 'family', null);
  raise exception 'FAIL 1: an app user called the eight-argument create_public_hold()';
exception when insufficient_privilege then
  raise notice 'PASS 1: an app user cannot call create_public_hold()';
end $$;

reset role;

-- ================================================ as the SERVICE (owner) ----

-- Each bad form is refused, and none of them leaves a row behind.
do $$
declare
  mon date := (select mon from p4);
  g uuid := 'a0000000-0000-4000-8000-000000000032';
  n int;
begin
  begin
    perform public.create_public_hold(g, 'villa_test31', mon, mon + 2, 'A', 2, 'family', null);
    raise exception 'FAIL 2a: a one-character name was accepted';
  exception when others then
    if sqlerrm not like 'oikoz:invalid_details%' then raise exception 'FAIL 2a: expected invalid_details, got %', sqlerrm; end if;
  end;

  begin
    perform public.create_public_hold(g, 'villa_test31', mon, mon + 2, '   ', 2, 'family', null);
    raise exception 'FAIL 2b: a blank name was accepted';
  exception when others then
    if sqlerrm not like 'oikoz:invalid_details%' then raise exception 'FAIL 2b: expected invalid_details, got %', sqlerrm; end if;
  end;

  begin
    perform public.create_public_hold(g, 'villa_test31', mon, mon + 2, repeat('x', 81), 2, 'family', null);
    raise exception 'FAIL 2c: an 81-character name was accepted';
  exception when others then
    if sqlerrm not like 'oikoz:invalid_details%' then raise exception 'FAIL 2c: expected invalid_details, got %', sqlerrm; end if;
  end;

  begin
    perform public.create_public_hold(g, 'villa_test31', mon, mon + 2, 'Ali', 2, 'party', null);
    raise exception 'FAIL 2d: an unknown client type was accepted';
  exception when others then
    if sqlerrm not like 'oikoz:invalid_details%' then raise exception 'FAIL 2d: expected invalid_details, got %', sqlerrm; end if;
  end;

  begin
    perform public.create_public_hold(g, 'villa_test31', mon, mon + 2, 'Ali', 2, null, null);
    raise exception 'FAIL 2e: a missing client type was accepted';
  exception when others then
    if sqlerrm not like 'oikoz:invalid_details%' then raise exception 'FAIL 2e: expected invalid_details, got %', sqlerrm; end if;
  end;

  begin
    perform public.create_public_hold(g, 'villa_test31', mon, mon + 2, 'Ali', 0, 'family', null);
    raise exception 'FAIL 2f: zero guests was accepted';
  exception when others then
    if sqlerrm not like 'oikoz:invalid_details%' then raise exception 'FAIL 2f: expected invalid_details, got %', sqlerrm; end if;
  end;

  begin
    perform public.create_public_hold(g, 'villa_test31', mon, mon + 2, 'Ali', null, 'family', null);
    raise exception 'FAIL 2g: a missing guest count was accepted';
  exception when others then
    if sqlerrm not like 'oikoz:invalid_details%' then raise exception 'FAIL 2g: expected invalid_details, got %', sqlerrm; end if;
  end;

  begin
    perform public.create_public_hold(g, 'villa_test31', mon, mon + 2, 'Ali', 2, 'family', repeat('n', 301));
    raise exception 'FAIL 2h: a 301-character note was accepted';
  exception when others then
    if sqlerrm not like 'oikoz:invalid_details%' then raise exception 'FAIL 2h: expected invalid_details, got %', sqlerrm; end if;
  end;

  select count(*) into n from public.bookings where client_user_id = g;
  if n <> 0 then raise exception 'FAIL 2i: a refused form left % booking(s)', n; end if;
  raise notice 'PASS 2: name, client type, guests and note are all validated server-side';
end $$;

-- Capacity is enforced: 5 guests at a villa for 4 is refused, 4 is fine.
do $$
declare
  mon date := (select mon from p4);
  h public.bookings%rowtype;
begin
  begin
    perform public.create_public_hold('a0000000-0000-4000-8000-000000000032', 'villa_test31',
                                      mon, mon + 2, 'Ali', 5, 'family', null);
    raise exception 'FAIL 3a: 5 guests at a villa for 4 was accepted';
  exception when others then
    if sqlerrm not like 'oikoz:too_many_guests%' then raise exception 'FAIL 3a: expected too_many_guests, got %', sqlerrm; end if;
  end;

  -- The typed name wins over the profile's, and is trimmed; so is the note.
  h := public.create_public_hold('a0000000-0000-4000-8000-000000000032', 'villa_test31',
                                 mon, mon + 2, '  Ali Valiyev  ', 4, 'friends_mixed', '  Late arrival, ~22:00  ');
  if h.guests_count <> 4 or h.client_type <> 'friends_mixed'
     or h.client_name <> 'Ali Valiyev' or h.notes <> 'Late arrival, ~22:00'
  then
    raise exception 'FAIL 3b: stored % / % / "%" / "%"', h.guests_count, h.client_type, h.client_name, h.notes;
  end if;
  if h.status <> 'pending' or h.client_phone <> '+998900000032' then
    raise exception 'FAIL 3c: hold is % with phone %', h.status, h.client_phone;
  end if;
  raise notice 'PASS 3: capacity enforced; details stored as typed, trimmed, with the phone on file';
end $$;

-- A 300-character note is fine; an empty one is stored as null.
do $$
declare
  mon date := (select mon from p4);
  h public.bookings%rowtype;
begin
  h := public.create_public_hold('a0000000-0000-4000-8000-000000000032', 'villa_test31',
                                 mon + 10, mon + 11, 'Ali', 1, 'couple', repeat('n', 300));
  if char_length(h.notes) <> 300 then raise exception 'FAIL 4a: 300-character note stored as % characters', char_length(h.notes); end if;

  h := public.create_public_hold('a0000000-0000-4000-8000-000000000033', 'villa_test31',
                                 mon + 20, mon + 21, 'Rival', 1, 'business', '   ');
  if h.notes is not null then raise exception 'FAIL 4b: a blank note was stored as "%"', h.notes; end if;
  raise notice 'PASS 4: a 300-character note is accepted; a blank one is stored as null';
end $$;

-- No capacity set: up to 30.
do $$
declare
  mon date := (select mon from p4);
  h public.bookings%rowtype;
begin
  begin
    perform public.create_public_hold('a0000000-0000-4000-8000-000000000034', 'villa_test32',
                                      mon, mon + 1, 'Big Group', 31, 'friends_men', null);
    raise exception 'FAIL 5a: 31 guests were accepted at a villa with no capacity';
  exception when others then
    if sqlerrm not like 'oikoz:too_many_guests%' then raise exception 'FAIL 5a: expected too_many_guests, got %', sqlerrm; end if;
  end;

  h := public.create_public_hold('a0000000-0000-4000-8000-000000000034', 'villa_test32',
                                 mon, mon + 1, 'Big Group', 30, 'friends_men', null);
  if h.guests_count <> 30 then raise exception 'FAIL 5b: stored % guests', h.guests_count; end if;
  raise notice 'PASS 5: with no capacity set, 30 guests are accepted and 31 refused';
end $$;

-- Two visitors racing for the same nights: the overlap constraint decides.
do $$
declare mon date := (select mon from p4);
begin
  perform public.create_public_hold('a0000000-0000-4000-8000-000000000033', 'villa_test31',
                                    mon + 1, mon + 3, 'Rival', 2, 'family', null);
  raise exception 'FAIL 6: an overlapping hold was accepted';
exception when others then
  if sqlerrm not like 'oikoz:dates_taken%' then raise exception 'FAIL 6: expected dates_taken, got %', sqlerrm; end if;
  raise notice 'PASS 6: overlapping dates are refused as dates_taken';
end $$;

-- The four-argument version still works until the new Edge Function is live.
do $$
declare
  mon date := (select mon from p4);
  h public.bookings%rowtype;
begin
  h := public.create_public_hold('a0000000-0000-4000-8000-000000000035', 'villa_test32', mon + 5, mon + 6);
  if h.status <> 'pending' or h.guests_count is not null or h.client_name <> 'P4 Old' then
    raise exception 'FAIL 7: four-argument hold is % / % guests / "%"', h.status, h.guests_count, h.client_name;
  end if;
  raise notice 'PASS 7: the four-argument create_public_hold() still works';
end $$;

-- The column itself refuses a nonsense count, whoever writes it.
do $$ begin
  update public.bookings set guests_count = 0
   where client_user_id = 'a0000000-0000-4000-8000-000000000034';
  raise exception 'FAIL 8: guests_count = 0 was stored';
exception when check_violation then
  raise notice 'PASS 8: guests_count must be at least 1';
end $$;

select 'Booking details verification: all checks passed (everything is rolled back next)' as result;

rollback;
