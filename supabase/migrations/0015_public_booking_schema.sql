-- ============================================================================
-- Public booking pages, part 1: schema, holds and owner setup.
--
-- Requires 0014 (the 'pending' / 'expired' enum values) to have been run, and
-- committed, first.
--
-- Everything here is additive. No existing column or row is rewritten; the
-- only redefinitions are the overlap constraint (same name, wider predicate)
-- and trigger functions, all of which can be put back from 0006 / 0012.
-- ============================================================================

-- --------------------------------------------- villas: channel makler ----
-- A standing default for who gets credited on this villa's public/channel
-- bookings: the same idea as crediting a makler on an owner-logged booking,
-- held at villa level. Optional; null means channel bookings credit nobody.

alter table public.villas add column if not exists default_channel_makler_id uuid;

do $$ begin
  alter table public.villas
    add constraint villas_default_channel_makler_id_fkey
    foreign key (default_channel_makler_id) references public.users (id) on delete set null;
exception when duplicate_object then null; end $$;

-- Same rule, and the same sentence, as bookings_compute() uses for a credited
-- makler -- so the app's existing error translation picks it up.
create or replace function public.villas_channel_makler_guard()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  -- The app sends the column on every save. Only judge a new value: a makler
  -- who later drops is_makler must not lock the owner out of saving rates.
  if tg_op = 'UPDATE'
     and new.default_channel_makler_id is not distinct from old.default_channel_makler_id
  then
    return new;
  end if;

  if new.default_channel_makler_id is not null
     and not exists (
       select 1 from public.users u where u.id = new.default_channel_makler_id and u.is_makler
     )
  then
    raise exception 'The credited user is not registered as a Makler'
      using errcode = 'check_violation';
  end if;
  return new;
end $$;

drop trigger if exists villas_channel_makler_guard_trg on public.villas;
create trigger villas_channel_makler_guard_trg
  before insert or update of default_channel_makler_id on public.villas
  for each row execute function public.villas_channel_makler_guard();

-- An owner cannot read an unrelated makler's users row (users_select only
-- covers people linked through villa_managers), so the setup screen asks for
-- the name through this. Owner-gated: a makler or client gets no rows.
create or replace function public.villa_channel_makler(p_villa_id uuid)
returns table (id uuid, oikoz_id text, name text)
language sql stable security definer set search_path = public as $$
  select u.id, u.oikoz_id, u.name
    from public.villas v
    join public.users u on u.id = v.default_channel_makler_id
   where v.id = p_villa_id
     and v.owner_id = auth.uid();
$$;

revoke all on function public.villa_channel_makler(uuid) from public;
revoke all on function public.villa_channel_makler(uuid) from anon;
grant execute on function public.villa_channel_makler(uuid) to authenticated;

-- ---------------------------------------------- payout card (side table) ----
-- The owner's own card number, which the public booking page will show to a
-- visitor paying the deposit.
--
-- It lives in its own table rather than on villas because RLS is row-level:
-- villas_select lets every linked makler read the WHOLE villa row, so a
-- column there would be readable by them. Here the only policy is the owner.
-- The public page will reach it in Phase 2 through a SECURITY DEFINER
-- function, never through this table.
--
-- Stored as 16 digits, no spaces. The app groups it for display.

create table if not exists public.villa_payout_details (
  villa_id    uuid primary key references public.villas (id) on delete cascade,
  card_number text not null,
  updated_at  timestamptz not null default now(),
  constraint villa_payout_card_format check (card_number ~ '^[0-9]{16}$')
);

alter table public.villa_payout_details enable row level security;

drop policy if exists villa_payout_details_select on public.villa_payout_details;
create policy villa_payout_details_select on public.villa_payout_details
  for select using (public.is_villa_owner(villa_id));

drop policy if exists villa_payout_details_insert on public.villa_payout_details;
create policy villa_payout_details_insert on public.villa_payout_details
  for insert with check (public.is_villa_owner(villa_id));

drop policy if exists villa_payout_details_update on public.villa_payout_details;
create policy villa_payout_details_update on public.villa_payout_details
  for update using (public.is_villa_owner(villa_id)) with check (public.is_villa_owner(villa_id));

drop policy if exists villa_payout_details_delete on public.villa_payout_details;
create policy villa_payout_details_delete on public.villa_payout_details
  for delete using (public.is_villa_owner(villa_id));

revoke all on public.villa_payout_details from anon;
grant select, insert, update, delete on public.villa_payout_details to authenticated;

create or replace function public.villa_payout_details_touch()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists villa_payout_details_touch_trg on public.villa_payout_details;
create trigger villa_payout_details_touch_trg
  before update on public.villa_payout_details
  for each row execute function public.villa_payout_details_touch();

-- ------------------------------------------------------ bookings: holds ----

alter table public.bookings add column if not exists hold_expires_at       timestamptz;
alter table public.bookings add column if not exists client_marked_paid_at timestamptz;

-- Both directions: only a pending row may carry an expiry, and a pending row
-- MUST carry one -- a hold with no expiry would block its dates forever.
do $$ begin
  alter table public.bookings
    add constraint bookings_hold_only_when_pending
    check ((status = 'pending') = (hold_expires_at is not null));
exception when duplicate_object then null; end $$;

-- What the cleanup sweeps look up.
create index if not exists bookings_pending_holds_idx
  on public.bookings (villa_id, hold_expires_at)
  where status = 'pending';

-- ------------------------------------------------------ overlap: the design --
-- An exclusion constraint cannot reference now(), so it cannot say "pending
-- AND not yet expired". Instead:
--
--   1. bookings_no_overlap now covers status IN ('confirmed', 'pending'), so a
--      hold reserves its nights with the same hard guarantee a confirmed
--      booking has -- including against two visitors racing for one weekend.
--   2. Before any write that would occupy nights on a villa, the
--      bookings_release_holds trigger flips that villa's expired holds to
--      'expired', so an expired hold never blocks a new booking.
--   3. A pg_cron job (0017) does the same sweep for every villa every two
--      minutes, so expired holds also disappear from calendars when nobody is
--      writing.
--
-- Tradeoff: between expiry and the next sweep, an expired hold is still
-- 'pending' in the table. Every WRITE path clears it first, so it can never
-- refuse anyone. READS must therefore treat a pending row as occupying its
-- nights only while hold_expires_at > now() -- the calendar does, and the
-- Phase 2 availability function must too. Worst case a calendar shows a hold
-- up to two minutes after it lapsed.

alter table public.bookings drop constraint if exists bookings_no_overlap;
alter table public.bookings
  add constraint bookings_no_overlap
  exclude using gist (
    villa_id with =,
    daterange(check_in, check_out, '[)') with &&
  ) where (status in ('confirmed', 'pending'));

-- Revoked from app users below: cron and the triggers call it as the owner.
-- p_except leaves out the row a trigger is currently writing, which Postgres
-- would refuse to have modified underneath it.
create or replace function public.release_expired_holds(p_villa_id uuid default null, p_except uuid default null)
returns integer language plpgsql security definer set search_path = public as $$
declare
  released integer;
begin
  update public.bookings
     set status = 'expired',
         hold_expires_at = null
   where status = 'pending'
     and hold_expires_at <= now()
     and (p_villa_id is null or villa_id = p_villa_id)
     and (p_except is null or id <> p_except);
  get diagnostics released = row_count;
  return released;
end $$;

revoke all on function public.release_expired_holds(uuid, uuid) from public;
revoke all on function public.release_expired_holds(uuid, uuid) from anon;
revoke all on function public.release_expired_holds(uuid, uuid) from authenticated;

-- Runs on INSERT and on UPDATE: a makler moving a booking's dates, or an owner
-- reopening a cancelled one, can land on an expired hold just as a new
-- booking can. Sweeps the whole villa, not only the overlapping range --
-- a superset, and one indexed statement either way.
create or replace function public.bookings_release_holds()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.status not in ('confirmed', 'pending') then
    return new;
  end if;

  if tg_op = 'UPDATE'
     and old.status = new.status
     and old.villa_id = new.villa_id
     and old.check_in = new.check_in
     and old.check_out = new.check_out
  then
    return new;  -- occupies exactly the nights it already did
  end if;

  perform public.release_expired_holds(new.villa_id, new.id);
  return new;
end $$;

drop trigger if exists bookings_release_holds_trg on public.bookings;
create trigger bookings_release_holds_trg
  before insert or update on public.bookings
  for each row execute function public.bookings_release_holds();

-- ------------------------------------------------- status guardrail ----
-- Holds are created and resolved only by server-side code: the Phase 2 and 3
-- Edge Functions (service role) and the sweep above. A signed-in app user may
-- not create a pending row -- otherwise a makler could post one expiring in
-- 2099 and lock a villa -- nor edit, confirm or revive one.
--
-- SECURITY INVOKER on purpose: current_user is then the role that actually
-- issued the write. Inside a SECURITY DEFINER function current_user is the
-- function's owner, which is exactly what lets the sweep through.

create or replace function public.bookings_status_guard()
returns trigger language plpgsql security invoker set search_path = public as $$
begin
  if current_user <> 'authenticated' then
    return new;
  end if;

  if tg_op = 'INSERT' then
    if new.status in ('pending', 'expired')
       or new.hold_expires_at is not null
       or new.client_marked_paid_at is not null
    then
      raise exception 'Deposit holds can only be created from the public booking page'
        using errcode = 'check_violation';
    end if;
    return new;
  end if;

  if old.status in ('pending', 'expired') then
    raise exception 'This booking is a deposit hold and cannot be changed in the app'
      using errcode = 'check_violation';
  end if;

  if new.status in ('pending', 'expired')
     or new.hold_expires_at is distinct from old.hold_expires_at
     or new.client_marked_paid_at is distinct from old.client_marked_paid_at
  then
    raise exception 'This booking is a deposit hold and cannot be changed in the app'
      using errcode = 'check_violation';
  end if;

  return new;
end $$;

drop trigger if exists bookings_status_guard_trg on public.bookings;
create trigger bookings_status_guard_trg
  before insert or update on public.bookings
  for each row execute function public.bookings_status_guard();

-- --------------------------------------------------------- money engine ----
-- As in 0012, plus one early exit: releasing a hold changes nothing but its
-- status, so there is nothing to recompute -- and recomputing could fail the
-- whole cron sweep on one row (e.g. the credited makler has since dropped
-- is_makler). Only reachable by server-side code: app users cannot touch a
-- pending row at all (bookings_status_guard).

create or replace function public.bookings_compute()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v public.villas%rowtype;
  min_deposit constant numeric := 100000;  -- UZS, like every deposit
  floor_total numeric;
begin
  if tg_op = 'UPDATE' and old.status = 'pending' and new.status = 'expired' then
    new.updated_at := now();
    return new;
  end if;

  select * into v from public.villas where id = new.villa_id;
  if not found then
    raise exception 'Villa % does not exist', new.villa_id;
  end if;

  -- The villa's currency is only a starting point; an explicit choice wins.
  if new.currency is null then
    new.currency := lower(v.currency)::booking_currency;
  end if;

  -- Only a registered makler can be credited, however the row got here.
  if new.manager_id is not null
     and not exists (select 1 from public.users u where u.id = new.manager_id and u.is_makler)
  then
    raise exception 'The credited user is not registered as a Makler'
      using errcode = 'check_violation';
  end if;

  if tg_op = 'INSERT' then
    new.commission_rate_snapshot := v.commission_rate;
  else
    new.commission_rate_snapshot := old.commission_rate_snapshot;
  end if;

  if new.deposit_amount is null then
    new.deposit_amount := v.deposit_amount;
  end if;
  if new.deposit_amount < min_deposit then
    raise exception 'Deposit must be at least % — got %', min_deposit, new.deposit_amount
      using errcode = 'check_violation';
  end if;

  new.platform_fee := round(new.total_price * v.platform_fee_rate, 2);

  if new.manager_id is null then
    -- Owner-logged with nobody credited: no commission exists to calculate.
    new.owner_net_amount   := null;
    new.manager_commission := 0;
    new.owner_payout       := new.total_price - new.platform_fee;

  elsif new.pricing_mode = 'owner_net' then
    if new.owner_net_amount is null then
      raise exception 'Enter the owner''s net amount for this booking'
        using errcode = 'check_violation';
    end if;

    floor_total := new.owner_net_amount + new.platform_fee;
    if new.total_price < floor_total then
      raise exception
        'Total price must be at least the owner''s net amount (% + % platform fee = %)',
        new.owner_net_amount, new.platform_fee, floor_total
        using errcode = 'check_violation';
    end if;

    new.owner_payout       := new.owner_net_amount;
    new.manager_commission := new.total_price - new.owner_net_amount - new.platform_fee;

  else
    new.owner_net_amount   := null;
    new.manager_commission := round(new.total_price * new.commission_rate_snapshot, 2);
    new.owner_payout       := new.total_price - new.platform_fee - new.manager_commission;
  end if;

  new.updated_at := now();
  return new;
end $$;

-- ------------------------------------------- blocked dates vs holds ----
-- As in 0006, with holds. A live hold blocks an owner's block exactly like a
-- confirmed booking; an expired-but-unswept one does not.

create or replace function public.blocked_dates_guard()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  clash public.bookings%rowtype;
  other public.blocked_dates%rowtype;
begin
  select * into clash
    from public.bookings b
   where b.villa_id = new.villa_id
     and (b.status = 'confirmed' or (b.status = 'pending' and b.hold_expires_at > now()))
     and daterange(b.check_in, b.check_out, '[)') && daterange(new.start_date, new.end_date, '[)')
   order by (b.status = 'confirmed') desc
   limit 1;

  if found and clash.status = 'pending' then
    raise exception 'These dates are on hold for a guest paying a deposit (arriving %).',
      to_char(clash.check_in, 'DD Mon')
      using errcode = 'check_violation';
  elsif found then
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

create or replace function public.bookings_block_guard()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  block_row public.blocked_dates%rowtype;
begin
  -- Cancelled and expired rows hold no nights, so they cannot clash.
  if new.status not in ('confirmed', 'pending') then
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
