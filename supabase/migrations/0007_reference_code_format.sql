-- ============================================================================
-- Reference code format: OKZ-0001 -> oikoz_id0001, VIL-0001 -> villa_id0001.
-- Literal prefix, four zero-padded digits, no separator.
-- ============================================================================

-- ------------------------------------------------------------- new defaults --

alter table public.users
  alter column oikoz_id set default 'oikoz_id' || lpad(nextval('public.oikoz_id_seq')::text, 4, '0');

alter table public.villas
  alter column villa_code set default 'villa_id' || lpad(nextval('public.villa_code_seq')::text, 4, '0');

-- ---------------------------------------------------------------- backfill --
-- Keep each row's existing number and only restyle the prefix, so anyone who
-- already wrote their code down keeps the same digits.

update public.users
   set oikoz_id = 'oikoz_id' || lpad(substring(oikoz_id from '[0-9]+$'), 4, '0')
 where oikoz_id ~ '[0-9]+$'
   and oikoz_id !~ '^oikoz_id[0-9]{4}$';

update public.villas
   set villa_code = 'villa_id' || lpad(substring(villa_code from '[0-9]+$'), 4, '0')
 where villa_code ~ '[0-9]+$'
   and villa_code !~ '^villa_id[0-9]{4}$';

-- Make sure the next mint cannot collide with a number that already exists:
-- a sequence sitting behind the backfilled maximum would hand out a duplicate.
do $$
declare highest bigint;
begin
  select coalesce(max(substring(oikoz_id from '[0-9]+$')::bigint), 0) into highest from public.users;
  if highest > (select last_value from public.oikoz_id_seq) then
    perform setval('public.oikoz_id_seq', highest);
  end if;

  select coalesce(max(substring(villa_code from '[0-9]+$')::bigint), 0) into highest from public.villas;
  if highest > (select last_value from public.villa_code_seq) then
    perform setval('public.villa_code_seq', highest);
  end if;
end $$;

-- ------------------------------------------------------- linking lookup ----
-- The new codes are lowercase, so the old upper() normalisation would stop
-- every lookup from matching. Accept what people actually type: the full code
-- in any case, or just the digits.

create or replace function public.link_manager_by_oikoz_id(p_villa_id uuid, p_oikoz_id text)
returns public.users language plpgsql security definer set search_path = public as $$
declare
  target public.users%rowtype;
  normalized text := lower(trim(p_oikoz_id));
begin
  if not public.is_villa_owner(p_villa_id) then
    raise exception 'Only the villa owner can add maklers';
  end if;

  -- "2", "0002", "oikoz_id2" and "OIKOZ_ID0002" all mean oikoz_id0002.
  if normalized ~ '^[0-9]+$' then
    normalized := 'oikoz_id' || lpad(normalized, 4, '0');
  elsif normalized ~ '^oikoz_id[0-9]+$' then
    normalized := 'oikoz_id' || lpad(substring(normalized from '[0-9]+$'), 4, '0');
  end if;

  select * into target from public.users where oikoz_id = normalized;
  if not found then
    raise exception 'No one has the reference %. Ask them to finish registration in the bot first.', normalized;
  end if;
  if not target.is_makler then
    raise exception '% is not registered as a Makler', coalesce(nullif(target.name, ''), normalized);
  end if;

  insert into public.villa_managers (villa_id, manager_id)
  values (p_villa_id, target.id)
  on conflict do nothing;

  return target;
end $$;

revoke all on function public.link_manager_by_oikoz_id(uuid, text) from public;
revoke all on function public.link_manager_by_oikoz_id(uuid, text) from anon;
grant execute on function public.link_manager_by_oikoz_id(uuid, text) to authenticated;
