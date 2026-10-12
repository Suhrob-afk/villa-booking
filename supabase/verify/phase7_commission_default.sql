-- ============================================================================
-- Commission default verification -- no migration; checks the live database.
--
-- 10% is meant to be the default makler commission everywhere. In the repo it
-- already is (villas.commission_rate defaults to 0.10 since 0001, and the
-- add-villa form starts at 10), and no later migration changes it. This
-- confirms the live database agrees, since the repo alone cannot prove that.
--
-- Paste the whole file into the SQL Editor and run it once.
--
--   * Every check raises an error starting "FAIL:" the moment it fails.
--   * If everything passes, the last result is a single row saying so.
--   * Wrapped in BEGIN ... ROLLBACK: the one test villa it inserts is gone
--     afterwards, and it never updates an existing villa or makler link.
--     Explicit oikoz_id / villa_code values keep the code sequences still.
-- ============================================================================

begin;

-- The column default, as written in the catalog.
do $$
declare d text;
begin
  select column_default into d
    from information_schema.columns
   where table_schema = 'public' and table_name = 'villas' and column_name = 'commission_rate';
  if d is null then
    raise exception 'FAIL 1: villas.commission_rate has no default';
  end if;
  if (d::text) !~ '^0?\.10*(::numeric)?$' then
    raise exception 'FAIL 1: villas.commission_rate default is %, expected 0.10', d;
  end if;
  raise notice 'PASS 1: villas.commission_rate defaults to %', d;
end $$;

-- The default as a new villa actually gets it: insert one without a rate.
insert into public.users (id, telegram_id, name, oikoz_id, is_owner, is_makler) values
  ('a0000000-0000-4000-8000-000000000071', -900000071, 'P7 Owner', 'oikoz_test71', true, false);

insert into public.villas (id, owner_id, name, currency, villa_code) values
  ('b0000000-0000-4000-8000-000000000071', 'a0000000-0000-4000-8000-000000000071',
   'P7 Villa', 'UZS', 'villa_test71');

do $$
declare r numeric;
begin
  select commission_rate into r from public.villas where id = 'b0000000-0000-4000-8000-000000000071';
  if r <> 0.10 then
    raise exception 'FAIL 2: a villa inserted without a rate got %, expected 0.10', r;
  end if;
  raise notice 'PASS 2: a new villa gets 10%% commission by default';
end $$;

-- Commission is per villa only: linking a makler carries no rate of its own.
do $$ begin
  if exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'villa_managers' and column_name ilike '%commission%'
  ) then
    raise exception 'FAIL 3: villa_managers has a commission column -- the per-makler default needs checking too';
  end if;
  raise notice 'PASS 3: villa_managers holds no per-makler commission';
end $$;

select 'Commission default verification: all checks passed (the test villa is rolled back next)' as result;

rollback;
