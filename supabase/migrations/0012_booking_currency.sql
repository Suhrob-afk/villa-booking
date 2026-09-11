-- ============================================================================
-- Per-booking currency.
--
-- Owners price the same villa, on the same night, differently for different
-- clients -- $100 to one group, 1,000,000 UZS to another -- so the currency
-- of a price belongs to the booking, not the villa. The villa's currency
-- becomes the default a new booking starts from, and a booking may override
-- it.
--
-- Every money column on a booking -- total_price, platform_fee,
-- manager_commission, owner_payout, owner_net_amount -- is in that booking's
-- currency. Nothing is converted, and nothing may be summed across
-- currencies. deposit_amount is the exception: a deposit is always UZS,
-- whatever the price is in.
--
-- Also lowers the deposit minimum from 200,000 to 100,000 UZS, for the villa
-- default and for each booking.
-- ============================================================================

-- ------------------------------------------------------- precondition ----
-- Villa currency has been free text (USD, UZS, EUR, RUB, KZT), but a booking
-- can only be UZS or USD, and existing bookings are about to inherit their
-- villa's currency as their label. Relabelling a EUR amount as UZS would
-- corrupt it silently, so refuse to run until any such villa is moved.

do $$
declare
  offending text;
begin
  select string_agg(format('%s (%s)', name, currency), ', ')
    into offending
    from public.villas
   where upper(currency) not in ('UZS', 'USD');

  if offending is not null then
    raise exception
      'Villas priced in a currency other than UZS or USD: %. Move them to UZS or USD first, or their bookings would be mislabelled.',
      offending;
  end if;
end $$;

update public.villas set currency = upper(currency) where currency <> upper(currency);

do $$ begin
  alter table public.villas
    add constraint villas_currency_supported check (currency in ('UZS', 'USD'));
exception when duplicate_object then null; end $$;

-- ---------------------------------------------------- booking currency ----

do $$ begin
  create type booking_currency as enum ('uzs', 'usd');
exception when duplicate_object then null; end $$;

alter table public.bookings add column if not exists currency booking_currency;

-- Every existing booking was priced in its villa's currency, so that is its
-- label. Triggers are off for this one statement: it is a pure relabel, and
-- letting bookings_compute() run would recompute platform_fee and
-- owner_payout from each villa's *current* rates -- rewriting history for any
-- villa whose platform fee has changed since.
alter table public.bookings disable trigger user;

update public.bookings b
   set currency = lower(v.currency)::booking_currency
  from public.villas v
 where v.id = b.villa_id
   and b.currency is null;

alter table public.bookings enable trigger user;

-- No column default: a default cannot see the villa. bookings_compute() fills
-- it from the villa when an insert leaves it out, and BEFORE ROW triggers run
-- ahead of the NOT NULL check.
alter table public.bookings alter column currency set not null;

-- ------------------------------------------------------ deposit minimum ----

alter table public.villas drop constraint if exists villas_deposit_minimum;
alter table public.villas
  add constraint villas_deposit_minimum check (deposit_amount >= 100000);

-- --------------------------------------------------------- money engine ----
-- Unchanged from 0008 apart from the lower deposit minimum and the currency
-- default. The arithmetic is currency-agnostic: rates are ratios, and every
-- amount it touches is already in the booking's own currency.

create or replace function public.bookings_compute()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v public.villas%rowtype;
  min_deposit constant numeric := 100000;  -- UZS, like every deposit
  floor_total numeric;
begin
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

-- ------------------------------------------------------ update guardrail ----
-- As in 0008, with currency added to what an owner may not change on a
-- booking a makler brought in: re-labelling the price is editing the price.

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
        new.deposit_amount, new.pricing_mode, new.owner_net_amount, new.currency)
       is distinct from
       (old.villa_id, old.manager_id, old.client_name, old.client_phone,
        old.check_in, old.check_out, old.total_price, old.notes,
        old.deposit_amount, old.pricing_mode, old.owner_net_amount, old.currency)
    then
      raise exception 'This booking belongs to a makler — you can cancel it or settle its commission';
    end if;
  end if;

  return new;
end $$;
