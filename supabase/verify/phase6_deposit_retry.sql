-- ============================================================================
-- "Not received" verification -- run AFTER migration 0023.
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
-- It calls mark_deposit_not_received() exactly as telegram-bot-webhook does,
-- with the tapper's Telegram id. now() is frozen for the whole transaction,
-- so "an hour from now" below means an hour from when this script started,
-- and a hold is made to lapse by moving its hold_expires_at into the past.
-- ============================================================================

begin;

-- ------------------------------------------------------ prerequisites ----
do $$ begin
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'bookings' and column_name = 'deposit_not_received_count'
  ) then
    raise exception 'FAIL 0a: bookings.deposit_not_received_count is missing -- run 0023';
  end if;
  if to_regprocedure('public.mark_deposit_not_received(bigint, uuid)') is null then
    raise exception 'FAIL 0b: mark_deposit_not_received() is missing -- run 0023';
  end if;
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.booking_owner_messages'::regclass
       and conname = 'booking_owner_messages_pkey'
       and array_length(conkey, 1) = 3
  ) then
    raise exception 'FAIL 0c: booking_owner_messages is not keyed by attempt yet -- run 0023';
  end if;
  raise notice 'PASS 0: 0023 applied';
end $$;

-- ------------------------------------------------------------- fixtures ----
-- owner    a...50  telegram -900000050, owns the villa
-- guest    a...51  the main retry story
-- guest2   a...52  confirmed after a Not received
-- guest3   a...53  holds that lapse
-- rival    a...54  wants the same nights
-- guest4   a...55  booked through a channel makler who then drops the flag
-- channel  a...56  makler, the villa's channel makler

insert into public.users (id, telegram_id, name, oikoz_id, phone, is_owner, is_makler) values
  ('a0000000-0000-4000-8000-000000000050', -900000050, 'P6 Owner',   'oikoz_test50', '+998900000050', true,  false),
  ('a0000000-0000-4000-8000-000000000051', -900000051, 'P6 Guest',   'oikoz_test51', '+998900000051', false, false),
  ('a0000000-0000-4000-8000-000000000052', -900000052, 'P6 Guest2',  'oikoz_test52', '+998900000052', false, false),
  ('a0000000-0000-4000-8000-000000000053', -900000053, 'P6 Guest3',  'oikoz_test53', '+998900000053', false, false),
  ('a0000000-0000-4000-8000-000000000054', -900000054, 'P6 Rival',   'oikoz_test54', '+998900000054', false, false),
  ('a0000000-0000-4000-8000-000000000055', -900000055, 'P6 Guest4',  'oikoz_test55', '+998900000055', false, false),
  ('a0000000-0000-4000-8000-000000000056', -900000056, 'P6 Channel', 'oikoz_test56', '+998900000056', false, true);

insert into public.villas (id, owner_id, name, currency, villa_code, weekday_price, weekend_price,
                           commission_rate, deposit_amount, capacity) values
  ('b0000000-0000-4000-8000-000000000051', 'a0000000-0000-4000-8000-000000000050',
   'P6 Villa', 'UZS', 'villa_test51', 1000000, 1500000, 0.10, 300000, 8);

insert into public.villa_payout_details (villa_id, card_number) values
  ('b0000000-0000-4000-8000-000000000051', '8600123412341234');

-- Since 0024 an owner needs an active subscription to change their villas,
-- and a lapsed owner's villa takes no new holds. Give this script's fixture
-- owners one when the table exists, so the script runs before and after 0024.
do $$ begin
  if to_regclass('public.subscriptions') is not null then
    execute $q$
      insert into public.subscriptions (user_id, paid_until)
      select distinct owner_id, now() + interval '30 days'
        from public.villas where villa_code like 'villa_test%'
      on conflict (user_id) do update set paid_until = excluded.paid_until
    $q$;
  end if;
end $$;

-- The Monday at least 30 days out, Tashkent time.
create temporary table p6 on commit drop as
select d as mon
  from (select (now() at time zone 'Asia/Tashkent')::date + 30 as base) b,
       lateral (select b.base + ((8 - extract(isodow from b.base)::int) % 7) as d) m;

create temporary table p6_ids (label text primary key, id uuid not null) on commit drop;
grant select on p6, p6_ids to authenticated;

-- The holds, each marked "I've sent the deposit".
do $$
declare
  mon date := (select mon from p6);
  h public.bookings%rowtype;
begin
  h := public.create_public_hold('a0000000-0000-4000-8000-000000000051', 'villa_test51', mon, mon + 2, 'Guest', 2, 'family', null);
  perform public.mark_public_hold_paid('a0000000-0000-4000-8000-000000000051', h.id);
  insert into p6_ids values ('h1', h.id);

  h := public.create_public_hold('a0000000-0000-4000-8000-000000000052', 'villa_test51', mon + 5, mon + 6, 'Guest2', 2, 'couple', null);
  perform public.mark_public_hold_paid('a0000000-0000-4000-8000-000000000052', h.id);
  insert into p6_ids values ('h2', h.id);

  h := public.create_public_hold('a0000000-0000-4000-8000-000000000053', 'villa_test51', mon + 10, mon + 11, 'Guest3', 1, 'business', null);
  perform public.mark_public_hold_paid('a0000000-0000-4000-8000-000000000053', h.id);
  insert into p6_ids values ('h3', h.id);

  h := public.create_public_hold('a0000000-0000-4000-8000-000000000053', 'villa_test51', mon + 15, mon + 16, 'Guest3', 1, 'business', null);
  perform public.mark_public_hold_paid('a0000000-0000-4000-8000-000000000053', h.id);
  insert into p6_ids values ('h4', h.id);
end $$;

-- ======================================================== as an APP USER ----
select set_config('request.jwt.claims',
  '{"sub":"a0000000-0000-4000-8000-000000000050","role":"authenticated"}', true);
set local role authenticated;

do $$ begin
  perform public.mark_deposit_not_received(-900000050, (select id from p6_ids where label = 'h1'));
  raise exception 'FAIL 1a: an app user called mark_deposit_not_received()';
exception when insufficient_privilege then
  raise notice 'PASS 1a: an app user cannot call mark_deposit_not_received()';
end $$;

do $$
declare mon date := (select mon from p6);
begin
  insert into public.bookings (villa_id, client_name, check_in, check_out, total_price, deposit_not_received_count)
  values ('b0000000-0000-4000-8000-000000000051', 'Spoof', mon + 200, mon + 201, 1000000, 1);
  raise exception 'FAIL 1b: an app user set deposit_not_received_count';
exception when check_violation then
  raise notice 'PASS 1b: an app user cannot set the Not received counter';
end $$;

reset role;

-- ================================================ as the SERVICE (owner) ----

-- Somebody who is not the owner taps Not received: nothing happens.
do $$
declare
  hid uuid := (select id from p6_ids where label = 'h1');
  r jsonb;
  h public.bookings%rowtype;
begin
  r := public.mark_deposit_not_received(-900000056, hid);
  if r->>'outcome' <> 'not_owner' then raise exception 'FAIL 2a: non-owner returned %', r; end if;
  select * into h from public.bookings where id = hid;
  if h.deposit_not_received_count <> 0 or h.client_marked_paid_at is null then
    raise exception 'FAIL 2b: a non-owner tap changed the hold';
  end if;
  raise notice 'PASS 2: only the villa owner can mark Not received';
end $$;

-- Press 1: still a hold, "sent" cleared, one hour more, counted.
do $$
declare
  hid uuid := (select id from p6_ids where label = 'h1');
  r jsonb;
  h public.bookings%rowtype;
begin
  r := public.mark_deposit_not_received(-900000050, hid);
  if r->>'outcome' <> 'not_received' or (r->>'count')::int <> 1 then
    raise exception 'FAIL 3a: first Not received returned %', r;
  end if;
  select * into h from public.bookings where id = hid;
  if h.status <> 'pending' then raise exception 'FAIL 3b: status became %', h.status; end if;
  if h.client_marked_paid_at is not null then raise exception 'FAIL 3c: "sent" was not cleared'; end if;
  if h.hold_expires_at <> now() + interval '1 hour' then
    raise exception 'FAIL 3d: hold_expires_at is %, expected now() + 1 hour', h.hold_expires_at;
  end if;
  if h.deposit_paid then raise exception 'FAIL 3e: deposit_paid was set'; end if;

  -- A double tap changes nothing.
  r := public.mark_deposit_not_received(-900000050, hid);
  if r->>'outcome' <> 'awaiting_guest' then raise exception 'FAIL 3f: double tap returned %', r; end if;
  select * into h from public.bookings where id = hid;
  if h.deposit_not_received_count <> 1 then raise exception 'FAIL 3g: double tap counted again (%)', h.deposit_not_received_count; end if;
  raise notice 'PASS 3: Not received keeps the hold, clears "sent", gives one hour; a double tap is a no-op';
end $$;

-- The dates are still the guest's.
do $$
declare mon date := (select mon from p6);
begin
  perform public.create_public_hold('a0000000-0000-4000-8000-000000000054', 'villa_test51', mon + 1, mon + 3, 'Rival', 2, 'family', null);
  raise exception 'FAIL 4: the rival got nights still held after Not received';
exception when others then
  if sqlerrm not like 'oikoz:dates_taken%' then raise exception 'FAIL 4: expected dates_taken, got %', sqlerrm; end if;
  raise notice 'PASS 4: after Not received the dates stay held';
end $$;

-- The guest pays again and taps "sent": two hours from now, and the
-- two-live-holds limit is not involved (no new hold is created).
do $$
declare
  hid uuid := (select id from p6_ids where label = 'h1');
  h public.bookings%rowtype;
begin
  select * into h from public.mark_public_hold_paid('a0000000-0000-4000-8000-000000000051', hid);
  if h.id is null then raise exception 'FAIL 5a: the guest could not tap "sent" again'; end if;
  if h.client_marked_paid_at is null then raise exception 'FAIL 5b: "sent" not recorded'; end if;
  if h.hold_expires_at <> now() + interval '2 hours' then
    raise exception 'FAIL 5c: hold_expires_at is %, expected now() + 2 hours', h.hold_expires_at;
  end if;
  raise notice 'PASS 5: a new "sent" after Not received extends to two hours';
end $$;

-- Press 2, sent again, press 3: the third releases the dates.
do $$
declare
  mon date := (select mon from p6);
  hid uuid := (select id from p6_ids where label = 'h1');
  r jsonb;
  h public.bookings%rowtype;
begin
  r := public.mark_deposit_not_received(-900000050, hid);
  if r->>'outcome' <> 'not_received' or (r->>'count')::int <> 2 then raise exception 'FAIL 6a: second press returned %', r; end if;

  perform public.mark_public_hold_paid('a0000000-0000-4000-8000-000000000051', hid);

  r := public.mark_deposit_not_received(-900000050, hid);
  if r->>'outcome' <> 'released' then raise exception 'FAIL 6b: third press returned %', r; end if;
  select * into h from public.bookings where id = hid;
  if h.status <> 'expired' or h.hold_expires_at is not null or h.deposit_not_received_count <> 3 then
    raise exception 'FAIL 6c: released hold is % / % / %', h.status, h.hold_expires_at, h.deposit_not_received_count;
  end if;

  -- Freed: the rival can now take those nights.
  perform public.create_public_hold('a0000000-0000-4000-8000-000000000054', 'villa_test51', mon + 1, mon + 3, 'Rival', 2, 'family', null);

  -- Never revived by another tap.
  r := public.mark_deposit_not_received(-900000050, hid);
  if r->>'outcome' not like 'expired_%' then raise exception 'FAIL 6d: tap after release returned %', r; end if;
  select * into h from public.bookings where id = hid;
  if h.status <> 'expired' then raise exception 'FAIL 6e: a released hold came back as %', h.status; end if;
  raise notice 'PASS 6: two Not received are allowed; the third releases the dates for good';
end $$;

-- Money arriving late: Deposit received still confirms after Not received.
do $$
declare
  hid uuid := (select id from p6_ids where label = 'h2');
  r jsonb;
begin
  r := public.mark_deposit_not_received(-900000050, hid);
  if r->>'outcome' <> 'not_received' then raise exception 'FAIL 7a: Not received returned %', r; end if;

  r := public.confirm_public_hold(-900000050, hid);
  if r->>'outcome' <> 'confirmed' then raise exception 'FAIL 7b: Deposit received after Not received returned %', r; end if;

  r := public.mark_deposit_not_received(-900000050, hid);
  if r->>'outcome' <> 'already_handled' or r->>'status' <> 'confirmed' then
    raise exception 'FAIL 7c: Not received on a confirmed booking returned %', r;
  end if;
  raise notice 'PASS 7: Deposit received still confirms after Not received; later taps are already_handled';
end $$;

-- Lapsed holds are never revived by Not received.
do $$
declare
  h3 uuid := (select id from p6_ids where label = 'h3');
  h4 uuid := (select id from p6_ids where label = 'h4');
  r jsonb;
  h public.bookings%rowtype;
begin
  -- Marked "sent", then ran out: the expired offer, nothing changed.
  update public.bookings set hold_expires_at = now() - interval '1 minute' where id = h4;
  r := public.mark_deposit_not_received(-900000050, h4);
  if r->>'outcome' <> 'expired_free' then raise exception 'FAIL 8a: lapsed hold returned %', r; end if;
  select * into h from public.bookings where id = h4;
  if h.deposit_not_received_count <> 0 or h.hold_expires_at > now() then
    raise exception 'FAIL 8b: Not received touched a lapsed hold';
  end if;

  -- Not received, then the guest never paid again and it ran out.
  perform public.mark_deposit_not_received(-900000050, h3);
  update public.bookings set hold_expires_at = now() - interval '1 minute' where id = h3;
  r := public.mark_deposit_not_received(-900000050, h3);
  if r->>'outcome' <> 'expired_closed' then raise exception 'FAIL 8c: unpaid lapsed hold returned %', r; end if;
  r := public.confirm_public_hold(-900000050, h3, true);
  if r->>'outcome' <> 'expired_closed' then raise exception 'FAIL 8d: Confirm anyway on it returned %', r; end if;
  raise notice 'PASS 8: lapsed holds get the expired offer, never a silent revival';
end $$;

-- A channel makler who drops the flag no longer blocks hold bookkeeping.
do $$
declare
  mon date := (select mon from p6);
  h public.bookings%rowtype;
  r jsonb;
begin
  update public.villas set default_channel_makler_id = 'a0000000-0000-4000-8000-000000000056'
   where id = 'b0000000-0000-4000-8000-000000000051';
  h := public.create_public_hold('a0000000-0000-4000-8000-000000000055', 'villa_test51', mon + 20, mon + 21, 'Guest4', 1, 'other', null);
  if h.manager_id is distinct from 'a0000000-0000-4000-8000-000000000056' then raise exception 'FAIL 9a: channel makler not credited'; end if;

  update public.users set is_makler = false where id = 'a0000000-0000-4000-8000-000000000056';

  perform public.mark_public_hold_paid('a0000000-0000-4000-8000-000000000055', h.id);
  r := public.mark_deposit_not_received(-900000050, h.id);
  if r->>'outcome' <> 'not_received' then raise exception 'FAIL 9b: Not received returned %', r; end if;
  select * into h from public.mark_public_hold_paid('a0000000-0000-4000-8000-000000000055', h.id);
  if h.client_marked_paid_at is null then raise exception 'FAIL 9c: "sent" again failed'; end if;
  raise notice 'PASS 9: hold bookkeeping works after the channel makler drops the flag';
end $$;

-- One owner message per (booking, kind, attempt).
do $$
declare hid uuid := (select id from p6_ids where label = 'h2');
begin
  insert into public.booking_owner_messages (booking_id, kind, attempt) values (hid, 'deposit_sent', 0);
  insert into public.booking_owner_messages (booking_id, kind, attempt) values (hid, 'deposit_sent', 1);
  begin
    insert into public.booking_owner_messages (booking_id, kind, attempt) values (hid, 'deposit_sent', 1);
  exception when unique_violation then
    raise notice 'PASS 10: each attempt gets one owner message, and only one';
    return;
  end;
  raise exception 'FAIL 10: a second message for the same attempt was claimed';
end $$;

select 'Not received verification: all checks passed (everything is rolled back next)' as result;

rollback;
