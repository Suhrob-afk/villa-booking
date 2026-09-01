-- ============================================================================
-- Owner-logged bookings.
--
-- Owners could previously only view (and cancel) bookings; taking one himself
-- meant asking a makler to enter it. That restriction is lifted here on
-- purpose. An owner-logged booking may credit a makler by oikoz reference for
-- a one-off commission, or credit nobody at all — in which case there is no
-- manager_id and no commission owed.
--
-- Note: bookings.manager_id was already nullable. What made a makler mandatory
-- was the insert policy (`manager_id = auth.uid()`), which is what changes.
-- ============================================================================

do $$ begin
  create type client_type as enum (
    'family', 'friends_mixed', 'friends_men', 'friends_women', 'couple', 'business', 'other'
  );
exception when duplicate_object then null; end $$;

alter table public.bookings add column if not exists client_type client_type;
alter table public.bookings add column if not exists deposit_paid boolean not null default false;

-- ------------------------------------------------------------ insert RLS ----
-- A villa's owner can now log bookings on their own villa. Maklers keep the
-- old rule: they may only file bookings crediting themselves.

drop policy if exists bookings_insert on public.bookings;
create policy bookings_insert on public.bookings
  for insert with check (
    public.is_villa_owner(villa_id)
    or (public.is_villa_manager(villa_id) and manager_id = auth.uid())
  );

-- --------------------------------------------------------- money engine ----
-- No credited makler means no commission owed to anyone: the owner keeps
-- everything except the platform's cut, whatever pricing mode is stored.

create or replace function public.bookings_compute()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v public.villas%rowtype;
  min_deposit constant numeric := 200000;
  floor_total numeric;
begin
  select * into v from public.villas where id = new.villa_id;
  if not found then
    raise exception 'Villa % does not exist', new.villa_id;
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

-- ------------------------------------------------------- update guardrail ----
-- Owners may always cancel, settle commission, mark the client's deposit paid,
-- and correct the client type. On a booking a makler brought in, the rest of
-- the details stay the makler's to edit. On a booking with nobody credited --
-- an owner's own -- the owner may edit everything.

create or replace function public.bookings_update_guard()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  owner_here   boolean := public.is_villa_owner(new.villa_id);
  manager_here boolean := public.is_villa_manager(new.villa_id);
begin
  if not owner_here and new.commission_status is distinct from old.commission_status then
    raise exception 'Only the villa owner can change commission status';
  end if;

  if not manager_here and old.manager_id is not null then
    if (new.villa_id, new.manager_id, new.client_name, new.client_phone,
        new.check_in, new.check_out, new.total_price, new.notes,
        new.deposit_amount, new.pricing_mode, new.owner_net_amount)
       is distinct from
       (old.villa_id, old.manager_id, old.client_name, old.client_phone,
        old.check_in, old.check_out, old.total_price, old.notes,
        old.deposit_amount, old.pricing_mode, old.owner_net_amount)
    then
      raise exception 'This booking belongs to a makler — you can cancel it or settle its commission';
    end if;
  end if;

  return new;
end $$;

-- ----------------------------------------------- crediting a makler by code --
-- An owner crediting a one-off makler cannot read that user's row (the two are
-- unrelated until this booking exists), so the lookup is SECURITY DEFINER and
-- returns only what the form needs to confirm the right person.

create or replace function public.find_makler_for_villa(p_villa_id uuid, p_oikoz_id text)
returns table (id uuid, oikoz_id text, name text)
language plpgsql security definer set search_path = public as $$
declare
  normalized text := lower(trim(p_oikoz_id));
begin
  -- Gated on villa ownership so the sequential codes cannot be enumerated.
  if not public.is_villa_owner(p_villa_id) then
    raise exception 'Only the villa owner can credit a makler';
  end if;

  if normalized ~ '^[0-9]+$' then
    normalized := 'oikoz_id' || lpad(normalized, 4, '0');
  elsif normalized ~ '^oikoz_id[0-9]+$' then
    normalized := 'oikoz_id' || lpad(substring(normalized from '[0-9]+$'), 4, '0');
  end if;

  return query
    select u.id, u.oikoz_id, u.name
      from public.users u
     where u.oikoz_id = normalized and u.is_makler;

  if not found then
    raise exception 'No makler has the reference %', normalized;
  end if;
end $$;

revoke all on function public.find_makler_for_villa(uuid, text) from public;
revoke all on function public.find_makler_for_villa(uuid, text) from anon;
grant execute on function public.find_makler_for_villa(uuid, text) to authenticated;
