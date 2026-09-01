-- ============================================================================
-- Per-booking pricing mode.
--
--   'percentage' — unchanged: the makler earns commission_rate_snapshot of
--                  the total, and the owner takes what is left.
--   'owner_net'  — the owner is promised a fixed net figure. Whatever the
--                  makler charges above that (less the platform fee) is the
--                  makler's cut.
--
-- The mode is per booking, not per villa: the same villa gets sold both ways
-- depending on the deal.
-- ============================================================================

do $$ begin
  create type pricing_mode as enum ('percentage', 'owner_net');
exception when duplicate_object then null; end $$;

alter table public.bookings
  add column if not exists pricing_mode pricing_mode not null default 'percentage';

alter table public.bookings
  add column if not exists owner_net_amount numeric(14, 2);

do $$ begin
  alter table public.bookings
    add constraint bookings_owner_net_non_negative
    check (owner_net_amount is null or owner_net_amount >= 0);
exception when duplicate_object then null; end $$;

-- --------------------------------------------------------- money engine ----

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

  if tg_op = 'INSERT' then
    new.commission_rate_snapshot := v.commission_rate;
  else
    new.commission_rate_snapshot := old.commission_rate_snapshot;
  end if;

  -- Deposit: pre-filled from the villa, floor held whatever the client sent.
  if new.deposit_amount is null then
    new.deposit_amount := v.deposit_amount;
  end if;
  if new.deposit_amount < min_deposit then
    raise exception 'Deposit must be at least % — got %', min_deposit, new.deposit_amount
      using errcode = 'check_violation';
  end if;

  -- The platform's cut comes off the top in both modes.
  new.platform_fee := round(new.total_price * v.platform_fee_rate, 2);

  if new.pricing_mode = 'owner_net' then
    if new.owner_net_amount is null then
      raise exception 'Enter the owner''s net amount for this booking'
        using errcode = 'check_violation';
    end if;

    -- Anything below this and the makler would be paying to work.
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
    -- owner_net_amount is meaningless in percentage mode; keep it null so the
    -- column always means what its name says.
    new.owner_net_amount   := null;
    new.manager_commission := round(new.total_price * new.commission_rate_snapshot, 2);
    new.owner_payout       := new.total_price - new.platform_fee - new.manager_commission;
  end if;

  new.updated_at := now();
  return new;
end $$;

-- ------------------------------------------------- bot: /role at any time ----
-- A separate step so the identity callback knows it is updating an existing
-- profile rather than finishing first-time onboarding.

alter table public.bot_onboarding_state drop constraint if exists bot_onboarding_state_step_check;
alter table public.bot_onboarding_state
  add constraint bot_onboarding_state_step_check
  check (step in ('language', 'phone', 'full_name', 'identity', 'role_update', 'done'));
