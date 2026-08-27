-- ============================================================================
-- Villa CRM — schema, money rules and Row Level Security
--
-- Identity model: users are authenticated by Telegram initData in the
-- `telegram-auth` Edge Function, which mints a Supabase JWT whose `sub` claim
-- is public.users.id. So auth.uid() == public.users.id everywhere below.
-- ============================================================================

create extension if not exists pgcrypto;
create extension if not exists btree_gist;

-- ---------------------------------------------------------------- enums ----
do $$ begin
  create type user_role as enum ('owner', 'manager');
exception when duplicate_object then null; end $$;

do $$ begin
  create type booking_status as enum ('confirmed', 'cancelled');
exception when duplicate_object then null; end $$;

do $$ begin
  create type commission_status as enum ('unpaid', 'paid');
exception when duplicate_object then null; end $$;

-- --------------------------------------------------------------- tables ----
create table if not exists public.users (
  id          uuid primary key default gen_random_uuid(),
  telegram_id bigint unique not null,
  name        text not null default '',
  phone       text,
  role        user_role not null,
  created_at  timestamptz not null default now()
);

create table if not exists public.villas (
  id                uuid primary key default gen_random_uuid(),
  owner_id          uuid not null references public.users (id) on delete cascade,
  name              text not null,
  location          text,
  -- Currency is per villa on purpose: one owner commonly mixes USD and UZS
  -- villas, so this must never become a global/app-level setting.
  currency          text not null default 'USD',
  weekday_price     numeric(14, 2) not null default 0 check (weekday_price >= 0),
  weekend_price     numeric(14, 2) not null default 0 check (weekend_price >= 0),
  commission_rate   numeric(6, 4) not null default 0.10 check (commission_rate >= 0 and commission_rate <= 1),
  platform_fee_rate numeric(6, 4) not null default 0 check (platform_fee_rate >= 0 and platform_fee_rate <= 1),
  capacity          integer check (capacity is null or capacity > 0),
  created_at        timestamptz not null default now()
);
create index if not exists villas_owner_id_idx on public.villas (owner_id);

create table if not exists public.villa_managers (
  villa_id   uuid not null references public.villas (id) on delete cascade,
  manager_id uuid not null references public.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (villa_id, manager_id)
);
create index if not exists villa_managers_manager_id_idx on public.villa_managers (manager_id);

create table if not exists public.bookings (
  id                       uuid primary key default gen_random_uuid(),
  villa_id                 uuid not null references public.villas (id) on delete cascade,
  manager_id               uuid references public.users (id) on delete set null,
  client_name              text not null,
  client_phone             text,
  check_in                 date not null,
  check_out                date not null,
  total_price              numeric(14, 2) not null default 0 check (total_price >= 0),
  commission_rate_snapshot numeric(6, 4) not null default 0,
  manager_commission       numeric(14, 2) not null default 0,
  platform_fee             numeric(14, 2) not null default 0,
  owner_payout             numeric(14, 2) not null default 0,
  commission_status        commission_status not null default 'unpaid',
  status                   booking_status not null default 'confirmed',
  notes                    text,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  constraint bookings_dates_ordered check (check_out > check_in)
);
create index if not exists bookings_villa_id_idx on public.bookings (villa_id);
create index if not exists bookings_manager_id_idx on public.bookings (manager_id);
create index if not exists bookings_range_idx on public.bookings (villa_id, check_in, check_out);

-- A stay occupies the nights [check_in, check_out): the checkout day is free
-- for the next guest to check in. Cancelled bookings free their nights.
alter table public.bookings drop constraint if exists bookings_no_overlap;
alter table public.bookings
  add constraint bookings_no_overlap
  exclude using gist (
    villa_id with =,
    daterange(check_in, check_out, '[)') with &&
  ) where (status = 'confirmed');

-- ------------------------------------------------- membership predicates ----
-- SECURITY DEFINER so RLS policies can consult these tables without the
-- policies on those tables re-triggering (which would recurse).

create or replace function public.is_villa_owner(vid uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.villas v where v.id = vid and v.owner_id = auth.uid()
  );
$$;

create or replace function public.is_villa_manager(vid uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.villa_managers vm
    where vm.villa_id = vid and vm.manager_id = auth.uid()
  );
$$;

create or replace function public.current_role_is(r user_role)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.users u where u.id = auth.uid() and u.role = r);
$$;

-- Two users are "related" when one owns a villa the other manages. That is the
-- only case where they may read each other's name/phone.
create or replace function public.is_related_user(uid uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1
    from public.villas v
    join public.villa_managers vm on vm.villa_id = v.id
    where (v.owner_id = auth.uid() and vm.manager_id = uid)
       or (vm.manager_id = auth.uid() and v.owner_id = uid)
  );
$$;

-- --------------------------------------------------------- money engine ----
-- Derived amounts are computed server-side from total_price so a client can
-- never post a booking with a flattering commission split.
--
--   platform_fee       = total_price * villa.platform_fee_rate
--   manager_commission = total_price * commission_rate_snapshot
--   owner_payout       = total_price - platform_fee - manager_commission
--
-- commission_rate_snapshot is frozen from the villa at creation time, so a
-- later rate change never rewrites the value of bookings already made.

create or replace function public.bookings_compute()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v public.villas%rowtype;
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

  new.platform_fee       := round(new.total_price * v.platform_fee_rate, 2);
  new.manager_commission := round(new.total_price * new.commission_rate_snapshot, 2);
  new.owner_payout       := new.total_price - new.platform_fee - new.manager_commission;
  new.updated_at         := now();
  return new;
end $$;

drop trigger if exists bookings_compute_trg on public.bookings;
create trigger bookings_compute_trg
  before insert or update on public.bookings
  for each row execute function public.bookings_compute();

-- ------------------------------------------------------- update guardrail ----
-- RLS grants row access but cannot restrict *which columns* a role may touch.
-- Owners may only cancel/reopen a booking and settle its commission; managers
-- may edit the booking itself but never mark their own commission paid.

create or replace function public.bookings_update_guard()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  owner_here   boolean := public.is_villa_owner(new.villa_id);
  manager_here boolean := public.is_villa_manager(new.villa_id);
begin
  if not owner_here and new.commission_status is distinct from old.commission_status then
    raise exception 'Only the villa owner can change commission status';
  end if;

  if not manager_here then
    if (new.villa_id, new.manager_id, new.client_name, new.client_phone,
        new.check_in, new.check_out, new.total_price, new.notes)
       is distinct from
       (old.villa_id, old.manager_id, old.client_name, old.client_phone,
        old.check_in, old.check_out, old.total_price, old.notes)
    then
      raise exception 'Owners may only cancel a booking or settle its commission';
    end if;
  end if;

  return new;
end $$;

drop trigger if exists bookings_update_guard_trg on public.bookings;
create trigger bookings_update_guard_trg
  before update on public.bookings
  for each row execute function public.bookings_update_guard();

-- ---------------------------------------------------- users guardrail ----
-- users_update_self lets a person edit their own row, but RLS cannot restrict
-- columns: without this, someone could flip their own role or claim another
-- Telegram id. Only name and phone are theirs to change.

create or replace function public.users_update_guard()
returns trigger language plpgsql as $$
begin
  if new.id is distinct from old.id
     or new.telegram_id is distinct from old.telegram_id
     or new.role is distinct from old.role
  then
    raise exception 'Only name and phone can be changed';
  end if;
  return new;
end $$;

drop trigger if exists users_update_guard_trg on public.users;
create trigger users_update_guard_trg
  before update on public.users
  for each row execute function public.users_update_guard();

-- ------------------------------------------------------------------ RLS ----
alter table public.users          enable row level security;
alter table public.villas         enable row level security;
alter table public.villa_managers enable row level security;
alter table public.bookings       enable row level security;

-- users -----------------------------------------------------------------
drop policy if exists users_select on public.users;
create policy users_select on public.users
  for select using (id = auth.uid() or public.is_related_user(id));

drop policy if exists users_update_self on public.users;
create policy users_update_self on public.users
  for update using (id = auth.uid()) with check (id = auth.uid());

-- Rows are created by the telegram-auth Edge Function (service role), which
-- bypasses RLS. No insert policy is granted to end users on purpose.

-- villas ----------------------------------------------------------------
drop policy if exists villas_select on public.villas;
create policy villas_select on public.villas
  for select using (owner_id = auth.uid() or public.is_villa_manager(id));

drop policy if exists villas_insert on public.villas;
create policy villas_insert on public.villas
  for insert with check (owner_id = auth.uid() and public.current_role_is('owner'));

drop policy if exists villas_update on public.villas;
create policy villas_update on public.villas
  for update using (owner_id = auth.uid()) with check (owner_id = auth.uid());

drop policy if exists villas_delete on public.villas;
create policy villas_delete on public.villas
  for delete using (owner_id = auth.uid());

-- villa_managers --------------------------------------------------------
drop policy if exists villa_managers_select on public.villa_managers;
create policy villa_managers_select on public.villa_managers
  for select using (manager_id = auth.uid() or public.is_villa_owner(villa_id));

drop policy if exists villa_managers_insert on public.villa_managers;
create policy villa_managers_insert on public.villa_managers
  for insert with check (public.is_villa_owner(villa_id));

drop policy if exists villa_managers_delete on public.villa_managers;
create policy villa_managers_delete on public.villa_managers
  for delete using (public.is_villa_owner(villa_id));

-- bookings --------------------------------------------------------------
drop policy if exists bookings_select on public.bookings;
create policy bookings_select on public.bookings
  for select using (public.is_villa_owner(villa_id) or public.is_villa_manager(villa_id));

drop policy if exists bookings_insert on public.bookings;
create policy bookings_insert on public.bookings
  for insert with check (public.is_villa_manager(villa_id) and manager_id = auth.uid());

drop policy if exists bookings_update on public.bookings;
create policy bookings_update on public.bookings
  for update
  using (public.is_villa_owner(villa_id) or public.is_villa_manager(villa_id))
  with check (public.is_villa_owner(villa_id) or public.is_villa_manager(villa_id));

-- Deleting is never allowed: bookings are cancelled, keeping the audit trail.

-- ----------------------------------------------------------- privileges ----
-- Supabase grants these by default; spelling them out keeps the intent
-- explicit and survives projects with tightened default privileges.
-- Every statement below is still filtered by the policies above.

grant usage on schema public to authenticated;
grant select, update on public.users to authenticated;
grant select, insert, update, delete on public.villas to authenticated;
grant select, insert, delete on public.villa_managers to authenticated;
grant select, insert, update on public.bookings to authenticated;

-- ------------------------------------------------------------ team RPCs ----
-- An owner links a manager by Telegram id. The manager must have signed in at
-- least once (so a users row exists) and must hold the 'manager' role.
-- SECURITY DEFINER because the owner cannot yet read that user row.

create or replace function public.link_manager_by_telegram_id(p_villa_id uuid, p_telegram_id bigint)
returns public.users language plpgsql security definer set search_path = public as $$
declare
  target public.users%rowtype;
begin
  if not public.is_villa_owner(p_villa_id) then
    raise exception 'Only the villa owner can add managers';
  end if;

  select * into target from public.users where telegram_id = p_telegram_id;
  if not found then
    raise exception 'No user with Telegram id %. Ask them to open the app once first.', p_telegram_id;
  end if;
  if target.role <> 'manager' then
    raise exception '% is registered as an owner, not a manager', coalesce(nullif(target.name, ''), p_telegram_id::text);
  end if;

  insert into public.villa_managers (villa_id, manager_id)
  values (p_villa_id, target.id)
  on conflict do nothing;

  return target;
end $$;

revoke all on function public.link_manager_by_telegram_id(uuid, bigint) from public;
grant execute on function public.link_manager_by_telegram_id(uuid, bigint) to authenticated;
