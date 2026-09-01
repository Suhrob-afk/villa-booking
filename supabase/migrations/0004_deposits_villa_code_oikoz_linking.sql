-- ============================================================================
-- Deposits, villa codes, oikoz-based linking, and retiring users.role
-- ============================================================================

-- ------------------------------------------------------ villas: deposit ----

alter table public.villas
  add column if not exists deposit_amount numeric(14, 2) not null default 250000;

-- A villa default below the per-booking floor would make the villa unbookable,
-- so the same floor applies here.
do $$ begin
  alter table public.villas
    add constraint villas_deposit_minimum check (deposit_amount >= 200000);
exception when duplicate_object then null; end $$;

-- --------------------------------------------------- villas: villa_code ----
-- Display only. Nothing joins on it; relations still use villas.id.

create sequence if not exists public.villa_code_seq;

alter table public.villas add column if not exists villa_code text;

alter table public.villas
  alter column villa_code set default 'VIL-' || lpad(nextval('public.villa_code_seq')::text, 4, '0');

update public.villas set villa_code = default where villa_code is null;

alter table public.villas alter column villa_code set not null;

create unique index if not exists villas_villa_code_key on public.villas (villa_code);

-- --------------------------------------------------- bookings: deposit ----
-- Left nullable in DDL on purpose: the compute trigger fills it from the
-- villa when the client omits it, which is what "pre-filled, editable"
-- means on the server side too.

alter table public.bookings add column if not exists deposit_amount numeric(14, 2);

update public.bookings b
   set deposit_amount = v.deposit_amount
  from public.villas v
 where v.id = b.villa_id and b.deposit_amount is null;

-- ---------------------------------------------------------- money engine ----
-- Same as before plus the deposit. The deposit is held against damages and is
-- NOT part of the commission split: it never touches total_price, the
-- platform fee, the makler's commission or the owner payout.

create or replace function public.bookings_compute()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v public.villas%rowtype;
  min_deposit constant numeric := 200000;
begin
  select * into v from public.villas where id = new.villa_id;
  if not found then
    raise exception 'Villa % does not exist', new.villa_id;
  end if;

  if tg_op = 'INSERT' then
    new.commission_rate_snapshot := v.commission_rate;
  else
    new.commission_rate_snapshot := old.commission_rate_snapshot;
  end if;

  -- Pre-fill from the villa, then hold the floor whatever the client sent.
  if new.deposit_amount is null then
    new.deposit_amount := v.deposit_amount;
  end if;
  if new.deposit_amount < min_deposit then
    raise exception 'Deposit must be at least % — got %', min_deposit, new.deposit_amount
      using errcode = 'check_violation';
  end if;

  new.platform_fee       := round(new.total_price * v.platform_fee_rate, 2);
  new.manager_commission := round(new.total_price * new.commission_rate_snapshot, 2);
  new.owner_payout       := new.total_price - new.platform_fee - new.manager_commission;
  new.updated_at         := now();
  return new;
end $$;

-- Backfilled rows are all populated by now, so the column can be required.
alter table public.bookings alter column deposit_amount set not null;

-- ------------------------------------------------------- retiring `role` ----
-- is_owner / is_makler are the only role signal the app reads. The enum column
-- stays for now (dropping it is a separate, destructive step) but nothing
-- writes or reads it any more, so it gets a default and loses its last
-- consumer: the villas_insert policy.

alter table public.users alter column role set default 'manager';

create or replace function public.current_is_owner()
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((select is_owner from public.users where id = auth.uid()), false);
$$;

drop policy if exists villas_insert on public.villas;
create policy villas_insert on public.villas
  for insert with check (owner_id = auth.uid() and public.current_is_owner());

drop function if exists public.current_role_is(user_role);

-- ------------------------------------------------------ oikoz-id linking ----
-- Owners add maklers by their OKZ reference. A 10-digit Telegram id is not
-- something anyone wants to read down a phone line.

drop function if exists public.link_manager_by_telegram_id(uuid, bigint);

create or replace function public.link_manager_by_oikoz_id(p_villa_id uuid, p_oikoz_id text)
returns public.users language plpgsql security definer set search_path = public as $$
declare
  target public.users%rowtype;
  normalized text := upper(trim(p_oikoz_id));
begin
  if not public.is_villa_owner(p_villa_id) then
    raise exception 'Only the villa owner can add maklers';
  end if;

  -- Tolerate someone typing "0001" or "okz-0001" for OKZ-0001.
  if normalized <> '' and normalized not like 'OKZ-%' then
    normalized := 'OKZ-' || normalized;
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
