-- ============================================================================
-- Name on the payout card -- run AFTER migration 0026.
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
-- A card saved before 0026 has no name. The rule only restrains app users
-- (owners in Villa Setup), so the script makes one by inserting as the SQL
-- Editor's own role, the way such rows came to exist.
-- ============================================================================

begin;

-- ------------------------------------------------------ prerequisites ----
do $$ begin
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'villa_payout_details' and column_name = 'card_holder_name'
  ) then
    raise exception 'FAIL 0a: villa_payout_details.card_holder_name is missing -- run 0026';
  end if;
  if not exists (
    select 1 from pg_trigger
     where tgrelid = 'public.villa_payout_details'::regclass and tgname = 'villa_payout_details_tidy_name_trg'
  ) then
    raise exception 'FAIL 0b: the card name trigger is missing -- run 0026';
  end if;
  raise notice 'PASS 0: 0026 applied';
end $$;

-- ------------------------------------------------------------- fixtures ----
-- owner     a...70  owns both villas
-- makler    a...71  assigned to both villas
-- stranger  a...72  owns nothing here
-- guest     a...73  books on the villa whose card has no name yet
--
-- new     b...70  no card yet: the owner adds one in this script
-- legacy  b...71  a card saved before 0026, without a name

insert into public.users (id, telegram_id, name, oikoz_id, phone, is_owner, is_makler) values
  ('a0000000-0000-4000-8000-000000000070', -900000070, 'P10 Owner',    'oikoz_test70', '+998900000070', true,  false),
  ('a0000000-0000-4000-8000-000000000071', -900000071, 'P10 Makler',   'oikoz_test71', '+998900000071', false, true),
  ('a0000000-0000-4000-8000-000000000072', -900000072, 'P10 Stranger', 'oikoz_test72', '+998900000072', true,  false),
  ('a0000000-0000-4000-8000-000000000073', -900000073, 'P10 Guest',    'oikoz_test73', '+998900000073', false, false);

insert into public.villas (id, owner_id, name, currency, villa_code, weekday_price, weekend_price,
                           commission_rate, deposit_amount, capacity) values
  ('b0000000-0000-4000-8000-000000000070', 'a0000000-0000-4000-8000-000000000070',
   'P10 New', 'UZS', 'villa_test70', 1000000, 1500000, 0.10, 300000, 8),
  ('b0000000-0000-4000-8000-000000000071', 'a0000000-0000-4000-8000-000000000070',
   'P10 Legacy', 'UZS', 'villa_test71', 1000000, 1500000, 0.10, 300000, 8);

insert into public.villa_managers (villa_id, manager_id) values
  ('b0000000-0000-4000-8000-000000000070', 'a0000000-0000-4000-8000-000000000071'),
  ('b0000000-0000-4000-8000-000000000071', 'a0000000-0000-4000-8000-000000000071');

-- Since 0024 an owner needs an active subscription to change their villas.
insert into public.subscriptions (user_id, paid_until)
values ('a0000000-0000-4000-8000-000000000070', now() + interval '30 days')
on conflict (user_id) do update set paid_until = excluded.paid_until;

-- The legacy card: stored the way it was before 0026, with no name.
insert into public.villa_payout_details (villa_id, card_number)
values ('b0000000-0000-4000-8000-000000000071', '8600111122223333');

-- ======================================================== as the OWNER ----
select set_config('request.jwt.claims',
  '{"sub":"a0000000-0000-4000-8000-000000000070","role":"authenticated"}', true);
set local role authenticated;

-- A new card needs its name.
do $$ begin
  insert into public.villa_payout_details (villa_id, card_number)
  values ('b0000000-0000-4000-8000-000000000070', '8600123412341234');
  raise exception 'FAIL 1a: a card was saved without a name';
exception when check_violation then
  if sqlerrm not like 'oikoz:card_name_required%' then raise exception 'FAIL 1a: unexpected error %', sqlerrm; end if;
  raise notice 'PASS 1a: a new card without a name is refused';
end $$;

do $$ begin
  insert into public.villa_payout_details (villa_id, card_number, card_holder_name)
  values ('b0000000-0000-4000-8000-000000000070', '8600123412341234', '   ');
  raise exception 'FAIL 1b: a card was saved with a blank name';
exception when check_violation then
  raise notice 'PASS 1b: a blank name counts as no name';
end $$;

-- Saved with a name: trimmed, inner spaces collapsed, letter case kept.
do $$
declare stored text;
begin
  insert into public.villa_payout_details (villa_id, card_number, card_holder_name)
  values ('b0000000-0000-4000-8000-000000000070', '8600123412341234', '  AZIZ    Karimov ');
  select card_holder_name into stored from public.villa_payout_details where villa_id = 'b0000000-0000-4000-8000-000000000070';
  if stored is distinct from 'AZIZ Karimov' then raise exception 'FAIL 1c: name stored as "%"', stored; end if;
  raise notice 'PASS 1c: a card with a name is saved, tidied';
end $$;

-- Over 100 characters is refused.
do $$ begin
  update public.villa_payout_details set card_holder_name = repeat('x', 101)
   where villa_id = 'b0000000-0000-4000-8000-000000000070';
  raise exception 'FAIL 1d: a 101-character name was stored';
exception when check_violation then
  raise notice 'PASS 1d: names are at most 100 characters';
end $$;

-- Clearing a name that was set is refused.
do $$ begin
  update public.villa_payout_details set card_holder_name = null
   where villa_id = 'b0000000-0000-4000-8000-000000000070';
  raise exception 'FAIL 1e: the name was cleared';
exception when check_violation then
  raise notice 'PASS 1e: a name, once set, cannot be cleared while the card stays';
end $$;

-- The legacy card keeps working until it is touched...
do $$
declare n int;
begin
  update public.villa_payout_details set card_number = card_number
   where villa_id = 'b0000000-0000-4000-8000-000000000071';
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'FAIL 2a: the legacy card could not be written as it is'; end if;

  -- ...Home finds it as the one villa whose card needs a name...
  select count(*) into n from public.villa_payout_details where card_holder_name is null;
  if n <> 1 then raise exception 'FAIL 2b: expected 1 villa missing a card name, found %', n; end if;
  raise notice 'PASS 2: a card from before 0026 keeps working and is found as missing its name';
end $$;

-- ...but a new number on it needs the name.
do $$ begin
  update public.villa_payout_details set card_number = '8600999988887777'
   where villa_id = 'b0000000-0000-4000-8000-000000000071';
  raise exception 'FAIL 3a: the legacy card''s number changed without a name';
exception when check_violation then
  raise notice 'PASS 3a: changing the number of a nameless card needs the name';
end $$;

do $$
declare stored text;
begin
  update public.villa_payout_details set card_holder_name = 'Aziz Karimov'
   where villa_id = 'b0000000-0000-4000-8000-000000000071';
  select card_holder_name into stored from public.villa_payout_details where villa_id = 'b0000000-0000-4000-8000-000000000071';
  if stored is distinct from 'Aziz Karimov' then raise exception 'FAIL 3b: name not added (%)', stored; end if;
  raise notice 'PASS 3b: the owner adds the name to the legacy card';
end $$;

reset role;

-- =================================================== nobody else can read ----
select set_config('request.jwt.claims',
  '{"sub":"a0000000-0000-4000-8000-000000000071","role":"authenticated"}', true);
set local role authenticated;

do $$
declare n int;
begin
  select count(*) into n from public.villa_payout_details;
  if n <> 0 then raise exception 'FAIL 4a: the makler can read % payout row(s)', n; end if;
  raise notice 'PASS 4a: a makler on the villa cannot read the card or its name';
end $$;

reset role;

select set_config('request.jwt.claims',
  '{"sub":"a0000000-0000-4000-8000-000000000072","role":"authenticated"}', true);
set local role authenticated;

do $$
declare n int;
begin
  select count(*) into n from public.villa_payout_details;
  if n <> 0 then raise exception 'FAIL 4b: another owner can read % payout row(s)', n; end if;
  raise notice 'PASS 4b: another owner cannot read the card or its name';
end $$;

reset role;

-- ============================================= a card without a name still books ----
-- Put the legacy villa back to "card, no name" and check guests can still
-- reserve: a missing name nudges the owner, it never blocks bookings.
update public.villa_payout_details set card_holder_name = null where villa_id = 'b0000000-0000-4000-8000-000000000071';

do $$
declare h public.bookings%rowtype;
begin
  h := public.create_public_hold('a0000000-0000-4000-8000-000000000073', 'villa_test71',
                                 (now() at time zone 'Asia/Tashkent')::date + 40,
                                 (now() at time zone 'Asia/Tashkent')::date + 42,
                                 'Guest', 2, 'family', null);
  if h.status <> 'pending' then raise exception 'FAIL 5: hold is %', h.status; end if;
  raise notice 'PASS 5: a villa whose card has no name still takes bookings';
exception when others then
  if sqlerrm like 'FAIL%' then raise; end if;
  raise exception 'FAIL 5: a villa whose card has no name refused a booking: %', sqlerrm;
end $$;

select 'Name on card verification: all checks passed (everything is rolled back next)' as result;

rollback;
