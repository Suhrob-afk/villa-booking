-- ============================================================================
-- Deposit receipts verification -- run AFTER migration 0025.
--
-- Paste the whole file into the SQL Editor and run it once.
--
--   * Every check raises an error starting "FAIL:" the moment it fails, so a
--     failure cannot be missed: the script stops there.
--   * If everything passes, the last result is a single row saying so.
--   * It is wrapped in BEGIN ... ROLLBACK and leaves nothing behind. Fixtures
--     use explicit oikoz_id / villa_code values, so not even the code
--     sequences advance. No file is uploaded: the receipt paths are just text.
--
-- It calls submit_deposit_receipt() exactly as telegram-bot-webhook does once
-- a screenshot is stored, or with a null path for "Send without receipt".
-- now() is frozen for the whole transaction.
-- ============================================================================

begin;

-- ------------------------------------------------------ prerequisites ----
do $$ begin
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'bookings' and column_name = 'deposit_receipt_path'
  ) then
    raise exception 'FAIL 0a: bookings.deposit_receipt_path is missing -- run 0025';
  end if;
  if to_regclass('public.deposit_receipt_requests') is null then
    raise exception 'FAIL 0b: public.deposit_receipt_requests is missing -- run 0025';
  end if;
  if to_regprocedure('public.submit_deposit_receipt(uuid, uuid, text)') is null then
    raise exception 'FAIL 0c: submit_deposit_receipt() is missing -- run 0025';
  end if;
  if not exists (select 1 from storage.buckets where id = 'receipts' and not public) then
    raise exception 'FAIL 0d: the private receipts bucket from 0024 is missing, or public';
  end if;
  raise notice 'PASS 0: 0025 applied, receipts bucket private';
end $$;

-- ------------------------------------------------------------- fixtures ----
-- owner   a...60  telegram -900000060, owns the villa
-- guest   a...61  two holds: the main story
-- other   a...62  another guest, trying to use the first guest's booking

insert into public.users (id, telegram_id, name, oikoz_id, phone, is_owner, is_makler) values
  ('a0000000-0000-4000-8000-000000000060', -900000060, 'P9 Owner', 'oikoz_test60', '+998900000060', true,  false),
  ('a0000000-0000-4000-8000-000000000061', -900000061, 'P9 Guest', 'oikoz_test61', '+998900000061', false, false),
  ('a0000000-0000-4000-8000-000000000062', -900000062, 'P9 Other', 'oikoz_test62', '+998900000062', false, false);

insert into public.villas (id, owner_id, name, currency, villa_code, weekday_price, weekend_price,
                           commission_rate, deposit_amount, capacity) values
  ('b0000000-0000-4000-8000-000000000061', 'a0000000-0000-4000-8000-000000000060',
   'P9 Villa', 'UZS', 'villa_test61', 1000000, 1500000, 0.10, 300000, 8);

insert into public.villa_payout_details (villa_id, card_number) values
  ('b0000000-0000-4000-8000-000000000061', '8600123412341234');

-- The owner needs an active subscription for the villa to take holds (0024).
insert into public.subscriptions (user_id, paid_until)
values ('a0000000-0000-4000-8000-000000000060', now() + interval '30 days')
on conflict (user_id) do update set paid_until = excluded.paid_until;

create temporary table p9_ids (label text primary key, id uuid not null) on commit drop;
grant select on p9_ids to authenticated;

do $$
declare
  base date := (now() at time zone 'Asia/Tashkent')::date + 40;
  h public.bookings%rowtype;
begin
  h := public.create_public_hold('a0000000-0000-4000-8000-000000000061', 'villa_test61', base, base + 2, 'Guest', 2, 'family', null);
  insert into p9_ids values ('h1', h.id);
  h := public.create_public_hold('a0000000-0000-4000-8000-000000000061', 'villa_test61', base + 5, base + 6, 'Guest', 2, 'family', null);
  insert into p9_ids values ('h2', h.id);
end $$;

-- ======================================================== as an APP USER ----
select set_config('request.jwt.claims',
  '{"sub":"a0000000-0000-4000-8000-000000000061","role":"authenticated"}', true);
set local role authenticated;

do $$ begin
  perform public.submit_deposit_receipt('a0000000-0000-4000-8000-000000000061',
                                        (select id from p9_ids where label = 'h1'), 'deposits/x/0.jpg');
  raise exception 'FAIL 1a: an app user called submit_deposit_receipt()';
exception when insufficient_privilege then
  raise notice 'PASS 1a: an app user cannot call submit_deposit_receipt()';
end $$;

do $$ begin
  perform 1 from public.deposit_receipt_requests;
  raise exception 'FAIL 1b: an app user can read deposit_receipt_requests';
exception when insufficient_privilege then
  raise notice 'PASS 1b: deposit_receipt_requests is closed to app users';
end $$;

-- The bucket's only read policy (0024) matches a path whose first folder is
-- the reader's own id. Deposit receipts start with 'deposits', which no id is.
do $$
declare path text := 'deposits/' || (select id from p9_ids where label = 'h1') || '/0-1700000000000.jpg';
begin
  if (storage.foldername(path))[1] <> 'deposits' then
    raise exception 'FAIL 1c: deposit receipts are not under the deposits/ folder';
  end if;
  if (storage.foldername(path))[1] = auth.uid()::text then
    raise exception 'FAIL 1d: the receipt folder policy would let this user read a deposit receipt';
  end if;
  raise notice 'PASS 1c: deposit receipts live under deposits/, which no user''s own-folder policy matches';
end $$;

reset role;

-- ================================================ as the SERVICE (bot) ----

-- Somebody else cannot submit a receipt for the guest's booking.
do $$
declare
  hid uuid := (select id from p9_ids where label = 'h1');
  n int;
  h public.bookings%rowtype;
begin
  select count(*) into n from public.submit_deposit_receipt('a0000000-0000-4000-8000-000000000062', hid, 'deposits/x.jpg');
  if n <> 0 then raise exception 'FAIL 2a: another visitor submitted a receipt for the guest''s hold'; end if;
  select * into h from public.bookings where id = hid;
  if h.client_marked_paid_at is not null or h.deposit_receipt_path is not null then
    raise exception 'FAIL 2b: the hold changed';
  end if;
  raise notice 'PASS 2: only the guest who made the hold can submit its receipt';
end $$;

-- The screenshot arrives: sent, two hours, path recorded -- and nothing more.
do $$
declare
  hid uuid := (select id from p9_ids where label = 'h1');
  path text := 'deposits/' || (select id from p9_ids where label = 'h1') || '/0-1700000000000.jpg';
  h public.bookings%rowtype;
  n int;
begin
  select * into h from public.submit_deposit_receipt('a0000000-0000-4000-8000-000000000061', hid, path);
  if h.id is null then raise exception 'FAIL 3a: the guest''s receipt was refused'; end if;
  if h.client_marked_paid_at is null then raise exception 'FAIL 3b: "sent" not recorded'; end if;
  if h.hold_expires_at <> now() + interval '2 hours' then
    raise exception 'FAIL 3c: hold_expires_at is %, expected now() + 2 hours', h.hold_expires_at;
  end if;
  if h.deposit_receipt_path is distinct from path then raise exception 'FAIL 3d: path stored as %', h.deposit_receipt_path; end if;
  if h.status <> 'pending' or h.deposit_paid then
    raise exception 'FAIL 3e: a receipt confirmed the booking (status %, deposit_paid %)', h.status, h.deposit_paid;
  end if;

  -- A second screenshot for the same attempt changes nothing.
  select count(*) into n from public.submit_deposit_receipt('a0000000-0000-4000-8000-000000000061', hid, 'deposits/again.jpg');
  if n <> 0 then raise exception 'FAIL 3f: a second receipt for the same attempt was accepted'; end if;
  select * into h from public.bookings where id = hid;
  if h.deposit_receipt_path is distinct from path then raise exception 'FAIL 3g: the second receipt replaced the first'; end if;
  raise notice 'PASS 3: a receipt marks the hold sent for two hours and records its path; it never confirms';
end $$;

-- Not received, then a retry with a new receipt: a new path, two more hours.
do $$
declare
  hid uuid := (select id from p9_ids where label = 'h1');
  r jsonb;
  h public.bookings%rowtype;
begin
  r := public.mark_deposit_not_received(-900000060, hid);
  if r->>'outcome' <> 'not_received' then raise exception 'FAIL 4a: Not received returned %', r; end if;

  select * into h from public.submit_deposit_receipt('a0000000-0000-4000-8000-000000000061', hid,
                                                     'deposits/' || hid || '/1-1700000001000.png');
  if h.id is null then raise exception 'FAIL 4b: the retry''s receipt was refused'; end if;
  if h.deposit_not_received_count <> 1 or h.deposit_receipt_path not like '%/1-%' then
    raise exception 'FAIL 4c: retry stored count % / path %', h.deposit_not_received_count, h.deposit_receipt_path;
  end if;
  if h.hold_expires_at <> now() + interval '2 hours' then raise exception 'FAIL 4d: retry hold is %', h.hold_expires_at; end if;

  -- Only the owner's Deposit received confirms.
  r := public.confirm_public_hold(-900000060, hid);
  if r->>'outcome' <> 'confirmed' then raise exception 'FAIL 4e: confirm returned %', r; end if;
  raise notice 'PASS 4: after Not received the guest sends a new receipt; only the owner confirms';
end $$;

-- "Send without receipt": sent, no path.
do $$
declare
  hid uuid := (select id from p9_ids where label = 'h2');
  h public.bookings%rowtype;
begin
  select * into h from public.submit_deposit_receipt('a0000000-0000-4000-8000-000000000061', hid, null);
  if h.id is null or h.client_marked_paid_at is null then raise exception 'FAIL 5a: sending without a receipt failed'; end if;
  if h.deposit_receipt_path is not null then raise exception 'FAIL 5b: a path was stored without a receipt'; end if;
  raise notice 'PASS 5: "Send without receipt" marks the hold sent with no path';
end $$;

-- A lapsed hold takes no receipt.
do $$
declare
  base date := (now() at time zone 'Asia/Tashkent')::date + 40;
  h public.bookings%rowtype;
  n int;
begin
  h := public.create_public_hold('a0000000-0000-4000-8000-000000000062', 'villa_test61', base + 10, base + 11, 'Other', 1, 'couple', null);
  update public.bookings set hold_expires_at = now() - interval '1 minute' where id = h.id;
  select count(*) into n from public.submit_deposit_receipt('a0000000-0000-4000-8000-000000000062', h.id, null);
  if n <> 0 then raise exception 'FAIL 6: a lapsed hold took a receipt'; end if;
  raise notice 'PASS 6: a lapsed hold takes no receipt';
end $$;

-- An app user cannot set a receipt path on any booking.
select set_config('request.jwt.claims',
  '{"sub":"a0000000-0000-4000-8000-000000000060","role":"authenticated"}', true);
set local role authenticated;

do $$
declare base date := (now() at time zone 'Asia/Tashkent')::date + 100;
begin
  insert into public.bookings (villa_id, client_name, check_in, check_out, total_price, deposit_receipt_path)
  values ('b0000000-0000-4000-8000-000000000061', 'Spoof', base, base + 1, 1000000, 'deposits/spoof.jpg');
  raise exception 'FAIL 7: an app user set deposit_receipt_path';
exception when check_violation then
  raise notice 'PASS 7: an app user cannot set deposit_receipt_path';
end $$;

reset role;

-- One remembered request per guest, gone with its booking.
do $$
declare hid uuid := (select id from p9_ids where label = 'h2');
begin
  insert into public.deposit_receipt_requests (telegram_id, booking_id) values (-900000061, hid);
  insert into public.deposit_receipt_requests (telegram_id, booking_id) values (-900000061, hid)
    on conflict (telegram_id) do update set booking_id = excluded.booking_id, requested_at = now();
  if (select count(*) from public.deposit_receipt_requests where telegram_id = -900000061) <> 1 then
    raise exception 'FAIL 8: more than one request per guest';
  end if;
  raise notice 'PASS 8: one remembered receipt request per guest';
end $$;

select 'Deposit receipts verification: all checks passed (everything is rolled back next)' as result;

rollback;
