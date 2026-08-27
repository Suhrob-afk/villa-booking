-- Optional demo data. Run it in the SQL editor AFTER both people have opened
-- the Mini App once (the Edge Function creates their users rows on first
-- login). Replace the two Telegram ids below with real ones.

do $$
declare
  owner_tg   bigint := 111111111;  -- <- the owner's Telegram id
  manager_tg bigint := 222222222;  -- <- the manager's Telegram id
  owner_id   uuid;
  manager_id uuid;
  villa_id   uuid;
begin
  select id into owner_id   from public.users where telegram_id = owner_tg;
  select id into manager_id from public.users where telegram_id = manager_tg;
  if owner_id is null or manager_id is null then
    raise exception 'Both users must sign in to the Mini App once before seeding';
  end if;

  insert into public.villas (owner_id, name, location, currency, weekday_price, weekend_price, commission_rate, capacity)
  values (owner_id, 'Chorvoq House', 'Chorvoq, Tashkent region', 'USD', 180, 240, 0.10, 12)
  returning id into villa_id;

  insert into public.villa_managers (villa_id, manager_id) values (villa_id, manager_id);

  insert into public.bookings (villa_id, manager_id, client_name, client_phone, check_in, check_out, total_price, notes)
  values (villa_id, manager_id, 'Aziz Karimov', '+998901234567',
          current_date + 5, current_date + 8, 660, 'Late check-in, ~22:00');

  -- A second villa in another currency, to exercise the per-currency grouping.
  insert into public.villas (owner_id, name, location, currency, weekday_price, weekend_price, commission_rate, capacity)
  values (owner_id, 'Chimgan Lodge', 'Chimgan', 'UZS', 2000000, 2800000, 0.12, 8)
  returning id into villa_id;

  insert into public.villa_managers (villa_id, manager_id) values (villa_id, manager_id);
end $$;
