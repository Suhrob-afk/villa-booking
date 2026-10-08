-- ============================================================================
-- Phase 1 verification -- run AFTER migrations 0014, 0015, 0016 and 0017.
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
-- authenticated plus a request.jwt.claims carrying their id as `sub`, which is
-- what auth.uid() reads.
-- ============================================================================

begin;

-- ------------------------------------------------------------- fixtures ----
-- owner   a...01  owns the test villa
-- makler  a...02  linked to it through villa_managers
-- client  a...03  bare client: is_owner = false, is_makler = false
-- makler2 a...04  a makler with no link, used as the channel default

insert into public.users (id, telegram_id, name, oikoz_id, is_owner, is_makler) values
  ('a0000000-0000-4000-8000-000000000001', -900000001, 'Test Owner',   'oikoz_test01', true,  false),
  ('a0000000-0000-4000-8000-000000000002', -900000002, 'Test Makler',  'oikoz_test02', false, true),
  ('a0000000-0000-4000-8000-000000000003', -900000003, 'Test Client',  'oikoz_test03', false, false),
  ('a0000000-0000-4000-8000-000000000004', -900000004, 'Test Makler2', 'oikoz_test04', false, true);

insert into public.villas (id, owner_id, name, currency, villa_code, weekday_price, weekend_price) values
  ('b0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001',
   'Verification Villa', 'UZS', 'villa_test01', 1000000, 1500000);

insert into public.villa_managers (villa_id, manager_id) values
  ('b0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000002');

insert into public.villa_payout_details (villa_id, card_number) values
  ('b0000000-0000-4000-8000-000000000001', '8600123412341234');

-- H1: a live hold, 10-13 March 2099 (nights 10, 11, 12).
insert into public.bookings (id, villa_id, client_name, check_in, check_out, status, hold_expires_at) values
  ('c0000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-000000000001',
   'Test visitor', '2099-03-10', '2099-03-13', 'pending', now() + interval '30 minutes');

-- H2: an expired hold nobody has swept yet, 10-13 April 2099.
insert into public.bookings (id, villa_id, client_name, check_in, check_out, status, hold_expires_at) values
  ('c0000000-0000-4000-8000-000000000002', 'b0000000-0000-4000-8000-000000000001',
   'Test visitor', '2099-04-10', '2099-04-13', 'pending', now() - interval '5 minutes');

-- ======================================================= as the MAKLER ----
select set_config('request.jwt.claims',
  '{"sub":"a0000000-0000-4000-8000-000000000002","role":"authenticated"}', true);
set local role authenticated;

do $$
declare n int;
begin
  -- Sanity: the makler really can see the villa row, so the next check means something.
  select count(*) into n from public.villas where id = 'b0000000-0000-4000-8000-000000000001';
  if n <> 1 then raise exception 'FAIL 1a: linked makler cannot see the villa (fixture problem)'; end if;

  select count(*) into n from public.villa_payout_details;
  if n <> 0 then raise exception 'FAIL 1b: linked makler can read the payout card'; end if;

  update public.villa_payout_details set card_number = '0000000000000000';
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'FAIL 1c: linked makler could overwrite the payout card'; end if;

  select count(*) into n from public.villa_channel_makler('b0000000-0000-4000-8000-000000000001');
  if n <> 0 then raise exception 'FAIL 1d: villa_channel_makler() answered a makler'; end if;
  raise notice 'PASS 1: makler cannot read or change the payout card';
end $$;

-- A confirmed booking over a live hold is refused by the overlap constraint.
do $$ begin
  begin
    insert into public.bookings (villa_id, manager_id, client_name, check_in, check_out, total_price)
    values ('b0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000002',
            'Clash', '2099-03-11', '2099-03-12', 1000000);
  exception when exclusion_violation then
    raise notice 'PASS 2: a live hold blocks overlapping bookings';
    return;
  end;
  raise exception 'FAIL 2: a confirmed booking was accepted over a live hold';
end $$;

-- An expired hold never blocks: the insert sweeps it out of the way first.
do $$ begin
  insert into public.bookings (villa_id, manager_id, client_name, check_in, check_out, total_price)
  values ('b0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000002',
          'Over expired hold', '2099-04-11', '2099-04-12', 1000000);
  raise notice 'PASS 3a: an expired hold did not block a new booking';
exception when others then
  raise exception 'FAIL 3a: an expired hold blocked a new booking: %', sqlerrm;
end $$;

-- Half-open ranges: the hold's check-out day is free to be a check-in.
do $$ begin
  insert into public.bookings (villa_id, manager_id, client_name, check_in, check_out, total_price)
  values ('b0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000002',
          'Next guest', '2099-03-13', '2099-03-15', 2000000);
  raise notice 'PASS 4: check-out day of a hold can be the next check-in';
exception when others then
  raise exception 'FAIL 4: booking on the hold''s check-out day was refused: %', sqlerrm;
end $$;

-- App users cannot create holds directly.
do $$ begin
  begin
    insert into public.bookings (villa_id, manager_id, client_name, check_in, check_out, status, hold_expires_at)
    values ('b0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000002',
            'Fake hold', '2099-06-01', '2099-06-05', 'pending', '2099-12-31');
  exception when check_violation then
    raise notice 'PASS 5: a makler cannot insert a pending hold';
    return;
  end;
  raise exception 'FAIL 5: a makler inserted a pending hold directly';
end $$;

do $$ begin
  begin
    perform public.release_expired_holds();
  exception when insufficient_privilege then
    raise notice 'PASS 6: app users cannot call release_expired_holds()';
    return;
  end;
  raise exception 'FAIL 6: an app user could call release_expired_holds()';
end $$;

reset role;

do $$
declare h public.bookings%rowtype;
begin
  select * into h from public.bookings where id = 'c0000000-0000-4000-8000-000000000002';
  if h.status <> 'expired' or h.hold_expires_at is not null then
    raise exception 'FAIL 3b: the expired hold was not released (status %, expiry %)', h.status, h.hold_expires_at;
  end if;
  raise notice 'PASS 3b: the expired hold is now status expired';
end $$;

-- ======================================================= as the CLIENT ----
select set_config('request.jwt.claims',
  '{"sub":"a0000000-0000-4000-8000-000000000003","role":"authenticated"}', true);
set local role authenticated;

do $$
declare n int;
begin
  select count(*) into n from public.villa_payout_details;
  if n <> 0 then raise exception 'FAIL 7a: a bare client can read payout cards'; end if;

  select count(*) into n from public.villas;
  if n <> 0 then raise exception 'FAIL 7b: a bare client can read villas'; end if;

  select count(*) into n from public.bookings;
  if n <> 0 then raise exception 'FAIL 7c: a bare client can read bookings'; end if;

  delete from public.villa_payout_details;
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'FAIL 7d: a bare client deleted a payout card'; end if;

  select count(*) into n from public.villa_channel_makler('b0000000-0000-4000-8000-000000000001');
  if n <> 0 then raise exception 'FAIL 7e: villa_channel_makler() answered a client'; end if;
  raise notice 'PASS 7: bare client sees no cards, villas or bookings';
end $$;

-- 0016: the users guard actually runs now.
do $$ begin
  begin
    update public.users set is_owner = true where id = 'a0000000-0000-4000-8000-000000000003';
  exception when others then
    if sqlerrm like 'Only name, full name, phone and language%' then
      raise notice 'PASS 8: a client cannot make themselves an owner';
      return;
    end if;
    raise;
  end;
  raise exception 'FAIL 8: a client set is_owner = true on themselves (users_update_guard is not running)';
end $$;

reset role;

-- H3: another expired, unswept hold, 10-12 May 2099. Created only now: any
-- successful booking write sweeps the villa, so an earlier H3 would already
-- be released by the makler tests above.
insert into public.bookings (id, villa_id, client_name, check_in, check_out, status, hold_expires_at) values
  ('c0000000-0000-4000-8000-000000000003', 'b0000000-0000-4000-8000-000000000001',
   'Test visitor', '2099-05-10', '2099-05-12', 'pending', now() - interval '5 minutes');

-- ======================================================== as the OWNER ----
select set_config('request.jwt.claims',
  '{"sub":"a0000000-0000-4000-8000-000000000001","role":"authenticated"}', true);
set local role authenticated;

do $$
declare
  n int;
  card text;
begin
  select count(*), max(card_number) into n, card from public.villa_payout_details;
  if n <> 1 or card <> '8600123412341234' then
    raise exception 'FAIL 9: owner cannot read their card, or it was changed (rows %, card %)', n, card;
  end if;
  raise notice 'PASS 9: owner reads their own card, unchanged by the makler and client';
end $$;

-- Default channel makler: a makler is accepted, a client is not.
do $$
declare n int;
begin
  update public.villas set default_channel_makler_id = 'a0000000-0000-4000-8000-000000000004'
   where id = 'b0000000-0000-4000-8000-000000000001';

  select count(*) into n from public.villa_channel_makler('b0000000-0000-4000-8000-000000000001')
   where oikoz_id = 'oikoz_test04';
  if n <> 1 then raise exception 'FAIL 10a: owner cannot see the channel makler they set'; end if;

  begin
    update public.villas set default_channel_makler_id = 'a0000000-0000-4000-8000-000000000003'
     where id = 'b0000000-0000-4000-8000-000000000001';
  exception when check_violation then
    raise notice 'PASS 10: channel makler must be a registered makler';
    return;
  end;
  raise exception 'FAIL 10b: a non-makler was accepted as the channel makler';
end $$;

-- The owner cannot confirm a hold from the app; that is Phase 3's job.
do $$ begin
  begin
    update public.bookings set status = 'confirmed' where id = 'c0000000-0000-4000-8000-000000000001';
  exception when check_violation then
    raise notice 'PASS 11: a hold cannot be confirmed from the app';
    return;
  end;
  raise exception 'FAIL 11: the owner flipped a pending hold to confirmed directly';
end $$;

-- Blocks: refused over a live hold, allowed over an expired one.
do $$ begin
  begin
    insert into public.blocked_dates (villa_id, start_date, end_date, reason, created_by)
    values ('b0000000-0000-4000-8000-000000000001', '2099-03-10', '2099-03-11', 'maintenance',
            'a0000000-0000-4000-8000-000000000001');
  exception when check_violation then
    raise notice 'PASS 12a: cannot block dates under a live hold';
    return;
  end;
  raise exception 'FAIL 12a: a block was accepted over a live hold';
end $$;

do $$ begin
  insert into public.blocked_dates (villa_id, start_date, end_date, reason, created_by)
  values ('b0000000-0000-4000-8000-000000000001', '2099-05-10', '2099-05-12', 'maintenance',
          'a0000000-0000-4000-8000-000000000001');
  raise notice 'PASS 12b: an expired hold does not stop a block';
exception when others then
  raise exception 'FAIL 12b: an expired hold stopped a block: %', sqlerrm;
end $$;

-- 0016: the villa delete guard actually runs now.
do $$ begin
  begin
    delete from public.villas where id = 'b0000000-0000-4000-8000-000000000001';
  exception when check_violation then
    raise notice 'PASS 13: a villa with bookings cannot be deleted';
    return;
  end;
  raise exception 'FAIL 13: a villa with bookings was deleted (villas_delete_guard is not running)';
end $$;

reset role;

-- ================================================ as postgres (server) ----

-- A pending row must carry an expiry.
do $$ begin
  begin
    insert into public.bookings (villa_id, client_name, check_in, check_out, status)
    values ('b0000000-0000-4000-8000-000000000001', 'No expiry', '2099-07-01', '2099-07-03', 'pending');
  exception when check_violation then
    raise notice 'PASS 14: a pending row without hold_expires_at is refused';
    return;
  end;
  raise exception 'FAIL 14: a pending row without an expiry was accepted';
end $$;

-- The cron sweep releases expired holds and leaves live ones alone.
do $$
declare
  released int;
  live text;
begin
  released := public.release_expired_holds();
  if released < 1 then raise exception 'FAIL 15a: release_expired_holds() released nothing (H3 is expired)'; end if;

  select status::text into live from public.bookings where id = 'c0000000-0000-4000-8000-000000000001';
  if live <> 'pending' then raise exception 'FAIL 15b: the sweep touched a live hold (now %)', live; end if;
  raise notice 'PASS 15: the sweep released % expired hold(s) and kept the live one', released;
end $$;

-- Pending and expired never count as revenue, commission or cancellations:
-- every money query filters status = 'confirmed', and Overview counts
-- status = 'cancelled' only.
do $$
declare n int;
begin
  select count(*) into n from public.bookings
   where villa_id = 'b0000000-0000-4000-8000-000000000001' and status = 'cancelled';
  if n <> 0 then raise exception 'FAIL 16: a hold ended up as cancelled'; end if;
  raise notice 'PASS 16: no hold was recorded as a cancellation';
end $$;

select 'Phase 1 verification: all checks passed (everything is rolled back next)' as result;

rollback;
