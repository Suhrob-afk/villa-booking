-- ============================================================================
-- Blocked dates — an owner closing off days for reasons that are not a guest:
-- their own stay, maintenance, or pulling the villa off the market.
--
-- Same half-open convention as bookings: a block covers [start_date, end_date),
-- so the end date is free to be someone's check-in.
-- ============================================================================

do $$ begin
  create type block_reason as enum ('owner_use', 'maintenance', 'off_market');
exception when duplicate_object then null; end $$;

create table if not exists public.blocked_dates (
  id         uuid primary key default gen_random_uuid(),
  villa_id   uuid not null references public.villas (id) on delete cascade,
  start_date date not null,
  end_date   date not null,
  reason     block_reason not null,
  created_by uuid references public.users (id) on delete set null,
  created_at timestamptz not null default now(),
  constraint blocked_dates_ordered check (end_date > start_date)
);

create index if not exists blocked_dates_villa_idx on public.blocked_dates (villa_id, start_date, end_date);

-- Backstop only: the trigger below raises a readable message first, and this
-- catches the narrow race where two blocks are inserted concurrently.
alter table public.blocked_dates drop constraint if exists blocked_dates_no_overlap;
alter table public.blocked_dates
  add constraint blocked_dates_no_overlap
  exclude using gist (
    villa_id with =,
    daterange(start_date, end_date, '[)') with &&
  );

create or replace function public.block_reason_label(r block_reason)
returns text language sql immutable as $$
  select case r
    when 'owner_use'   then 'Owner use'
    when 'maintenance' then 'Maintenance'
    else                    'Off market'
  end;
$$;

-- ------------------------------------------------------- two-way overlap ----
-- Bookings and blocks live in different tables, so neither an exclusion
-- constraint nor a CHECK can see across the pair. A trigger on each side
-- keeps them mutually exclusive, and each raises a sentence a person can act
-- on rather than a constraint name.

create or replace function public.blocked_dates_guard()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  clash public.bookings%rowtype;
  other public.blocked_dates%rowtype;
begin
  select * into clash
    from public.bookings b
   where b.villa_id = new.villa_id
     and b.status = 'confirmed'
     and daterange(b.check_in, b.check_out, '[)') && daterange(new.start_date, new.end_date, '[)')
   limit 1;

  if found then
    raise exception 'These dates already have a booking (% arriving %).',
      clash.client_name, to_char(clash.check_in, 'DD Mon')
      using errcode = 'check_violation';
  end if;

  select * into other
    from public.blocked_dates d
   where d.villa_id = new.villa_id
     and d.id is distinct from new.id
     and daterange(d.start_date, d.end_date, '[)') && daterange(new.start_date, new.end_date, '[)')
   limit 1;

  if found then
    raise exception 'These dates are already blocked (%).', public.block_reason_label(other.reason)
      using errcode = 'check_violation';
  end if;

  return new;
end $$;

drop trigger if exists blocked_dates_guard_trg on public.blocked_dates;
create trigger blocked_dates_guard_trg
  before insert or update on public.blocked_dates
  for each row execute function public.blocked_dates_guard();

create or replace function public.bookings_block_guard()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  block_row public.blocked_dates%rowtype;
begin
  -- A cancelled booking holds no nights, so it cannot clash with anything.
  if new.status <> 'confirmed' then
    return new;
  end if;

  select * into block_row
    from public.blocked_dates d
   where d.villa_id = new.villa_id
     and daterange(d.start_date, d.end_date, '[)') && daterange(new.check_in, new.check_out, '[)')
   limit 1;

  if found then
    raise exception 'These dates are blocked (%).', public.block_reason_label(block_row.reason)
      using errcode = 'check_violation';
  end if;

  return new;
end $$;

drop trigger if exists bookings_block_guard_trg on public.bookings;
create trigger bookings_block_guard_trg
  before insert or update on public.bookings
  for each row execute function public.bookings_block_guard();

-- ------------------------------------------------------------------ RLS ----
-- Maklers can see blocks (their calendar has to show the villa as unavailable)
-- but only the owner can put one there or take it away.

alter table public.blocked_dates enable row level security;

drop policy if exists blocked_dates_select on public.blocked_dates;
create policy blocked_dates_select on public.blocked_dates
  for select using (public.is_villa_owner(villa_id) or public.is_villa_manager(villa_id));

drop policy if exists blocked_dates_insert on public.blocked_dates;
create policy blocked_dates_insert on public.blocked_dates
  for insert with check (public.is_villa_owner(villa_id) and created_by = auth.uid());

drop policy if exists blocked_dates_update on public.blocked_dates;
create policy blocked_dates_update on public.blocked_dates
  for update using (public.is_villa_owner(villa_id)) with check (public.is_villa_owner(villa_id));

drop policy if exists blocked_dates_delete on public.blocked_dates;
create policy blocked_dates_delete on public.blocked_dates
  for delete using (public.is_villa_owner(villa_id));

grant select, insert, update, delete on public.blocked_dates to authenticated;
revoke all on public.blocked_dates from anon;
