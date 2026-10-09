-- ============================================================================
-- Phase 3 verification -- run AFTER migrations 0019 and 0020.
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
-- It exercises the database half of the bot's Confirm / Reject buttons:
-- confirm_public_hold() and reject_public_hold() are exactly what
-- telegram-bot-webhook calls, with the tapper's Telegram id. Sending and
-- editing Telegram messages is covered by the manual checklist instead.
--
-- Note: now() is frozen for a whole transaction, so a hold is made to lapse
-- here by moving its hold_expires_at into the past.
-- ============================================================================

begin;

-- ------------------------------------------------------ prerequisites ----
do $$ begin
  if not exists (
    select 1 from pg_enum e join pg_type t on t.oid = e.enumtypid
     where t.typname = 'booking_status' and e.enumlabel = 'rejected'
  ) then
    raise exception 'FAIL 0a: booking_status has no ''rejected'' value -- run 0019 on its own first';
  end if;
  if to_regclass('public.booking_owner_messages') is null then
    raise exception 'FAIL 0b: public.booking_owner_messages is missing -- run 0020';
  end if;
  if to_regprocedure('public.confirm_public_hold(bigint, uuid, boolean)') is null
     or to_regprocedure('public.reject_public_hold(bigint, uuid)') is null
  then
    raise exception 'FAIL 0c: confirm_public_hold / reject_public_hold are missing -- run 0020';
  end if;
  raise notice 'PASS 0: 0019 and 0020 applied';
end $$;

-- ------------------------------------------------------------- fixtures ----
-- owner    a...21  telegram -900000021, owns the test villa
-- channel  a...22  telegram -900000022, makler, the villa's channel makler
-- guest    a...23  bare client with a phone
-- rival    a...24  bare client with a phone
-- guest2   a...25  bare client with a phone
-- guest3   a...26  bare client with a phone
--
-- villa    b...21  UZS, 1,000,000 weekday / 1,500,000 weekend, 10% commission,
--                  payout card, channel makler set.

insert into public.users (id, telegram_id, name, oikoz_id, phone, is_owner, is_makler) values
  ('a0000000-0000-4000-8000-000000000021', -900000021, 'P3 Owner',   'oikoz_test21', '+998900000021', true,  false),
  ('a0000000-0000-4000-8000-000000000022', -900000022, 'P3 Channel', 'oikoz_test22', '+998900000022', false, true),
  ('a0000000-0000-4000-8000-000000000023', -900000023, 'P3 Guest',   'oikoz_test23', '+998900000023', false, false),
  ('a0000000-0000-4000-8000-000000000024', -900000024, 'P3 Rival',   'oikoz_test24', '+998900000024', false, false),
  ('a0000000-0000-4000-8000-000000000025', -900000025, 'P3 Guest2',  'oikoz_test25', '+998900000025', false, false),
  ('a0000000-0000-4000-8000-000000000026', -900000026, 'P3 Guest3',  'oikoz_test26', '+998900000026', false, false);

insert into public.villas (id, owner_id, name, currency, villa_code, weekday_price, weekend_price,
                           commission_rate, deposit_amount, default_channel_makler_id) values
  ('b0000000-0000-4000-8000-000000000021', 'a0000000-0000-4000-8000-000000000021',
   'P3 Villa', 'UZS', 'villa_test21', 1000000, 1500000, 0.10, 300000,
   'a0000000-0000-4000-8000-000000000022');

insert into public.villa_payout_details (villa_id, card_number) values
  ('b0000000-0000-4000-8000-000000000021', '8600123412341234');

-- The Monday at least 30 days out, Tashkent time. Mon -> Wed is two weekday
-- nights: 2,000,000.
create temporary table p3 on commit drop as
select d as mon
  from (select (now() at time zone 'Asia/Tashkent')::date + 30 as base) b,
       lateral (select b.base + ((8 - extract(isodow from b.base)::int) % 7) as d) m;

-- Booking ids by label, filled in as the holds are created.
create temporary table p3_ids (label text primary key, id uuid not null) on commit drop;

-- The checks that run as an app user read these too.
grant select on p3, p3_ids to authenticated;

-- ======================================================== as an APP USER ----
select set_config('request.jwt.claims',
  '{"sub":"a0000000-0000-4000-8000-000000000021","role":"authenticated"}', true);
set local role authenticated;

do $$ begin
  begin
    perform public.confirm_public_hold(-900000021, 'c0000000-0000-4000-8000-000000000099');
  exception when insufficient_privilege then
    begin
      perform public.reject_public_hold(-900000021, 'c0000000-0000-4000-8000-000000000099');
    exception when insufficient_privilege then
      raise notice 'PASS 1a: an app user cannot call confirm_public_hold() or reject_public_hold()';
      return;
    end;
    raise exception 'FAIL 1a: an app user called reject_public_hold()';
  end;
  raise exception 'FAIL 1a: an app user called confirm_public_hold()';
end $$;

do $$ begin
  perform 1 from public.booking_owner_messages;
  raise exception 'FAIL 1b: an app user can read booking_owner_messages';
exception when insufficient_privilege then
  raise notice 'PASS 1b: booking_owner_messages is closed to app users';
end $$;

-- The owner cannot create a rejected row themselves.
do $$
declare mon date := (select mon from p3);
begin
  begin
    insert into public.bookings (villa_id, client_name, check_in, check_out, total_price, status)
    values ('b0000000-0000-4000-8000-000000000021', 'Spoof', mon + 200, mon + 201, 1000000, 'rejected');
  exception when check_violation then
    raise notice 'PASS 1c: an app user cannot create a rejected booking';
    return;
  end;
  raise exception 'FAIL 1c: an app user created a rejected booking';
end $$;

reset role;

-- ================================================ as the SERVICE (owner) ----
-- What the Edge Functions do, minus the HTTP and Telegram.

-- An in-app booking is not a public hold: the buttons never apply to it.
do $$
declare
  mon date := (select mon from p3);
  bid uuid;
begin
  insert into public.bookings (villa_id, client_name, check_in, check_out, total_price, status)
  values ('b0000000-0000-4000-8000-000000000021', 'Phone booking', mon + 100, mon + 102, 2000000, 'confirmed')
  returning id into bid;
  if public.confirm_public_hold(-900000021, bid)->>'outcome' <> 'not_found'
     or public.reject_public_hold(-900000021, bid)->>'outcome' <> 'not_found'
  then
    raise exception 'FAIL 2: an in-app booking was treated as a public hold';
  end if;
  raise notice 'PASS 2: in-app bookings are out of reach of the bot buttons';
end $$;

-- H1: the guest holds Mon -> Wed and says they paid.
do $$
declare
  mon date := (select mon from p3);
  h public.bookings%rowtype;
begin
  h := public.create_public_hold('a0000000-0000-4000-8000-000000000023', 'villa_test21', mon, mon + 2);
  perform public.mark_public_hold_paid('a0000000-0000-4000-8000-000000000023', h.id);
  insert into p3_ids values ('h1', h.id);
end $$;

-- Somebody who is not the owner -- here the villa's own makler -- taps.
do $$
declare
  hid uuid := (select id from p3_ids where label = 'h1');
  r jsonb;
  h public.bookings%rowtype;
begin
  r := public.confirm_public_hold(-900000022, hid);
  if r->>'outcome' <> 'not_owner' then raise exception 'FAIL 3a: non-owner confirm returned %', r; end if;
  r := public.reject_public_hold(-900000022, hid);
  if r->>'outcome' <> 'not_owner' then raise exception 'FAIL 3b: non-owner reject returned %', r; end if;
  r := public.confirm_public_hold(-999999999, hid);
  if r->>'outcome' <> 'not_owner' then raise exception 'FAIL 3c: stranger confirm returned %', r; end if;

  select * into h from public.bookings where id = hid;
  if h.status <> 'pending' or h.deposit_paid then
    raise exception 'FAIL 3d: a non-owner tap changed the hold (status %, deposit_paid %)', h.status, h.deposit_paid;
  end if;
  raise notice 'PASS 3: taps from anyone but the villa owner change nothing';
end $$;

-- The owner confirms.
do $$
declare
  hid uuid := (select id from p3_ids where label = 'h1');
  r jsonb;
  h public.bookings%rowtype;
begin
  r := public.confirm_public_hold(-900000021, hid);
  if r->>'outcome' <> 'confirmed' then raise exception 'FAIL 4a: owner confirm returned %', r; end if;

  select * into h from public.bookings where id = hid;
  if h.status <> 'confirmed' or not h.deposit_paid or h.hold_expires_at is not null then
    raise exception 'FAIL 4b: confirmed row is status %, deposit_paid %, hold_expires_at %',
      h.status, h.deposit_paid, h.hold_expires_at;
  end if;
  if h.manager_id is distinct from 'a0000000-0000-4000-8000-000000000022'
     or h.total_price <> 2000000
     or h.manager_commission <> 200000
  then
    raise exception 'FAIL 4c: money wrong after confirm: makler %, total %, commission %',
      h.manager_id, h.total_price, h.manager_commission;
  end if;

  -- What Breakdown and Commissions read.
  if not exists (
    select 1 from public.bookings
     where id = hid and status = 'confirmed' and manager_id = 'a0000000-0000-4000-8000-000000000022'
  ) then
    raise exception 'FAIL 4d: the confirmed booking is not visible to the confirmed-only queries';
  end if;

  -- A second tap, on either button.
  r := public.confirm_public_hold(-900000021, hid);
  if r->>'outcome' <> 'already_handled' or r->>'status' <> 'confirmed' then
    raise exception 'FAIL 4e: second confirm returned %', r;
  end if;
  r := public.reject_public_hold(-900000021, hid);
  if r->>'outcome' <> 'already_handled' or r->>'status' <> 'confirmed' then
    raise exception 'FAIL 4f: reject after confirm returned %', r;
  end if;
  raise notice 'PASS 4: owner confirm -> confirmed, deposit paid, makler credited; repeat taps are already_handled';
end $$;

-- The confirmed booking now owns its nights for good.
do $$
declare mon date := (select mon from p3);
begin
  perform public.create_public_hold('a0000000-0000-4000-8000-000000000024', 'villa_test21', mon + 1, mon + 3);
  raise exception 'FAIL 5: a hold overlapping a confirmed booking was accepted';
exception when others then
  if sqlerrm not like 'oikoz:dates_taken%' then raise exception 'FAIL 5: expected dates_taken, got %', sqlerrm; end if;
  raise notice 'PASS 5: confirmed dates are refused to the next visitor';
end $$;

-- H2: the guest holds Thu -> Sat and says they paid; the owner rejects.
do $$
declare
  mon date := (select mon from p3);
  h public.bookings%rowtype;
  r jsonb;
begin
  h := public.create_public_hold('a0000000-0000-4000-8000-000000000023', 'villa_test21', mon + 3, mon + 5);
  perform public.mark_public_hold_paid('a0000000-0000-4000-8000-000000000023', h.id);
  insert into p3_ids values ('h2', h.id);

  r := public.reject_public_hold(-900000021, h.id);
  if r->>'outcome' <> 'rejected' then raise exception 'FAIL 6a: owner reject returned %', r; end if;

  select * into h from public.bookings where id = h.id;
  if h.status <> 'rejected' or h.hold_expires_at is not null or h.deposit_paid then
    raise exception 'FAIL 6b: rejected row is status %, hold_expires_at %, deposit_paid %',
      h.status, h.hold_expires_at, h.deposit_paid;
  end if;

  r := public.reject_public_hold(-900000021, h.id);
  if r->>'outcome' <> 'already_handled' or r->>'status' <> 'rejected' then
    raise exception 'FAIL 6c: second reject returned %', r;
  end if;
  r := public.confirm_public_hold(-900000021, h.id, true);
  if r->>'outcome' <> 'already_handled' then
    raise exception 'FAIL 6d: confirm after reject returned %', r;
  end if;

  -- Released immediately: someone else can take exactly those nights now.
  perform public.create_public_hold('a0000000-0000-4000-8000-000000000024', 'villa_test21', mon + 3, mon + 5);
  raise notice 'PASS 6: owner reject -> rejected, dates free at once, cannot be confirmed afterwards';
end $$;

-- An app user (the owner, in the app) cannot revive a rejected hold.
select set_config('request.jwt.claims',
  '{"sub":"a0000000-0000-4000-8000-000000000021","role":"authenticated"}', true);
set local role authenticated;

do $$
declare hid uuid := (select id from p3_ids where label = 'h2');
begin
  update public.bookings set status = 'confirmed' where id = hid;
  raise exception 'FAIL 7: the owner reopened a rejected hold in the app';
exception when check_violation then
  raise notice 'PASS 7: a rejected hold cannot be changed in the app';
end $$;

-- 0020 narrowed bookings_update_guard() to app users; for them it must still
-- stop an owner editing the price of a makler's booking.
do $$
declare hid uuid := (select id from p3_ids where label = 'h1');
begin
  update public.bookings set total_price = 1 where id = hid;
  raise exception 'FAIL 7b: the owner changed the price of a makler-credited booking';
exception when raise_exception then
  if sqlerrm not like 'This booking belongs to a makler%' then raise exception 'FAIL 7b: unexpected error %', sqlerrm; end if;
  raise notice 'PASS 7b: owners still cannot edit a makler booking''s price in the app';
end $$;

reset role;

-- H3: paid, but the hold lapses before the owner answers. Dates still free.
do $$
declare
  mon date := (select mon from p3);
  h public.bookings%rowtype;
  r jsonb;
begin
  h := public.create_public_hold('a0000000-0000-4000-8000-000000000023', 'villa_test21', mon + 7, mon + 9);
  perform public.mark_public_hold_paid('a0000000-0000-4000-8000-000000000023', h.id);
  update public.bookings set hold_expires_at = now() - interval '1 minute' where id = h.id;

  -- Not swept yet: still 'pending' in the table, but lapsed.
  r := public.confirm_public_hold(-900000021, h.id);
  if r->>'outcome' <> 'expired_free' then raise exception 'FAIL 8a: lapsed confirm returned %', r; end if;
  select * into h from public.bookings where id = h.id;
  if h.status <> 'pending' or h.deposit_paid then
    raise exception 'FAIL 8b: a lapsed hold was confirmed without "Confirm anyway" (status %)', h.status;
  end if;

  -- "Confirm anyway".
  r := public.confirm_public_hold(-900000021, h.id, true);
  if r->>'outcome' <> 'confirmed' then raise exception 'FAIL 8c: Confirm anyway returned %', r; end if;
  select * into h from public.bookings where id = h.id;
  if h.status <> 'confirmed' or not h.deposit_paid or h.hold_expires_at is not null then
    raise exception 'FAIL 8d: re-confirmed row is status %, deposit_paid %', h.status, h.deposit_paid;
  end if;
  raise notice 'PASS 8: a lapsed hold is never confirmed silently; Confirm anyway works while the dates are free';
end $$;

-- H4: paid, lapsed, swept to 'expired', and the dates taken by somebody else.
do $$
declare
  mon date := (select mon from p3);
  h public.bookings%rowtype;
  r jsonb;
begin
  h := public.create_public_hold('a0000000-0000-4000-8000-000000000025', 'villa_test21', mon + 14, mon + 16);
  perform public.mark_public_hold_paid('a0000000-0000-4000-8000-000000000025', h.id);
  update public.bookings set hold_expires_at = now() - interval '1 minute' where id = h.id;
  perform public.release_expired_holds();

  select * into h from public.bookings where id = h.id;
  if h.status <> 'expired' then raise exception 'FAIL 9a: the sweep left status %', h.status; end if;

  perform public.create_public_hold('a0000000-0000-4000-8000-000000000024', 'villa_test21', mon + 15, mon + 17);

  r := public.confirm_public_hold(-900000021, h.id);
  if r->>'outcome' <> 'expired_taken' then raise exception 'FAIL 9b: confirm on taken dates returned %', r; end if;
  r := public.confirm_public_hold(-900000021, h.id, true);
  if r->>'outcome' <> 'expired_taken' then raise exception 'FAIL 9c: Confirm anyway on taken dates returned %', r; end if;
  select * into h from public.bookings where id = h.id;
  if h.status <> 'expired' then raise exception 'FAIL 9d: status changed to %', h.status; end if;
  raise notice 'PASS 9: a lapsed hold whose dates were taken cannot be confirmed';
end $$;

-- H5: lapsed WITHOUT the guest ever saying they paid: never revivable. The
-- owner can still reject it, so the guest hears an answer.
do $$
declare
  mon date := (select mon from p3);
  h public.bookings%rowtype;
  r jsonb;
begin
  h := public.create_public_hold('a0000000-0000-4000-8000-000000000025', 'villa_test21', mon + 21, mon + 23);
  update public.bookings set hold_expires_at = now() - interval '1 minute' where id = h.id;

  r := public.confirm_public_hold(-900000021, h.id, true);
  if r->>'outcome' <> 'expired_closed' then raise exception 'FAIL 10a: unpaid lapsed hold returned %', r; end if;

  r := public.reject_public_hold(-900000021, h.id);
  if r->>'outcome' <> 'rejected' then raise exception 'FAIL 10b: rejecting a lapsed hold returned %', r; end if;
  raise notice 'PASS 10: an unpaid lapsed hold cannot be confirmed; a lapsed hold can still be rejected';
end $$;

-- H6: paid and lapsed, but check-in is now in the past: never revivable.
do $$
declare
  mon date := (select mon from p3);
  today date := (now() at time zone 'Asia/Tashkent')::date;
  h public.bookings%rowtype;
  r jsonb;
begin
  h := public.create_public_hold('a0000000-0000-4000-8000-000000000026', 'villa_test21', mon + 28, mon + 30);
  perform public.mark_public_hold_paid('a0000000-0000-4000-8000-000000000026', h.id);
  update public.bookings set hold_expires_at = now() - interval '1 minute' where id = h.id;
  perform public.release_expired_holds();
  update public.bookings set check_in = today - 3, check_out = today - 1 where id = h.id;

  r := public.confirm_public_hold(-900000021, h.id, true);
  if r->>'outcome' <> 'expired_closed' then raise exception 'FAIL 11: past check-in returned %', r; end if;
  raise notice 'PASS 11: Confirm anyway is refused once check-in has passed';
end $$;

-- H7: the channel makler drops is_makler before the owner confirms. The
-- booking is confirmed crediting nobody, rather than the confirm failing.
do $$
declare
  mon date := (select mon from p3);
  h public.bookings%rowtype;
  r jsonb;
begin
  h := public.create_public_hold('a0000000-0000-4000-8000-000000000026', 'villa_test21', mon + 35, mon + 37);
  if h.manager_id is distinct from 'a0000000-0000-4000-8000-000000000022' then
    raise exception 'FAIL 12a: the hold did not credit the channel makler';
  end if;
  perform public.mark_public_hold_paid('a0000000-0000-4000-8000-000000000026', h.id);

  update public.users set is_makler = false where id = 'a0000000-0000-4000-8000-000000000022';

  r := public.confirm_public_hold(-900000021, h.id);
  if r->>'outcome' <> 'confirmed' then raise exception 'FAIL 12b: confirm returned %', r; end if;
  select * into h from public.bookings where id = h.id;
  if h.manager_id is not null or h.manager_commission <> 0 then
    raise exception 'FAIL 12c: expected no makler and zero commission, got % / %', h.manager_id, h.manager_commission;
  end if;
  raise notice 'PASS 12: a former makler is not credited on confirm; the confirm still succeeds';
end $$;

-- Rejected and expired holds are never sales or cancellations.
do $$
declare n int;
begin
  select count(*) into n from public.bookings
   where villa_id = 'b0000000-0000-4000-8000-000000000021' and status = 'cancelled';
  if n <> 0 then raise exception 'FAIL 13a: % booking(s) counted as cancelled', n; end if;

  select count(*) into n from public.bookings
   where villa_id = 'b0000000-0000-4000-8000-000000000021' and status = 'rejected';
  if n <> 2 then raise exception 'FAIL 13b: expected 2 rejected holds, found %', n; end if;

  -- Confirmed: the phone booking, H1, H3 and H7.
  select count(*) into n from public.bookings
   where villa_id = 'b0000000-0000-4000-8000-000000000021' and status = 'confirmed';
  if n <> 4 then raise exception 'FAIL 13c: expected 4 confirmed bookings, found %', n; end if;
  raise notice 'PASS 13: rejected holds are neither revenue nor cancellations';
end $$;

-- One owner message per (booking, kind): the claim the Edge Functions make.
do $$
declare hid uuid := (select id from p3_ids where label = 'h1');
begin
  insert into public.booking_owner_messages (booking_id, kind) values (hid, 'deposit_sent');
  begin
    insert into public.booking_owner_messages (booking_id, kind) values (hid, 'deposit_sent');
  exception when unique_violation then
    raise notice 'PASS 14: a second deposit_sent message for one booking is refused';
    return;
  end;
  raise exception 'FAIL 14: two deposit_sent messages were claimed for one booking';
end $$;

select 'Phase 3 verification: all checks passed (everything is rolled back next)' as result;

rollback;
