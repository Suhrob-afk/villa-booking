-- ============================================================================
-- Owner subscriptions: 49,000 UZS for 30 days, per account.
--
-- Additive only. New tables, functions, triggers, a private Storage bucket,
-- and one data seed: every user who is an owner when this first runs gets 30
-- days free. No existing row or policy is changed.
--
--   subscriptions          one row per user; paid_until null = never paid
--   subscription_payments  each payment attempt: a receipt to check today, a
--                          Payme/Click transaction later
--
-- The gate is on THE VILLA'S OWNER, not on whoever is acting:
--
--   * A change to a villa -- the villa itself, its payout card, its maklers,
--     its bookings, its blocked dates -- needs that villa's owner to have an
--     active subscription, whoever makes it. A linked makler works normally
--     on a paying owner's villa and is read-only on a lapsed owner's villa.
--   * Creating a villa needs the CREATING user to have one, whatever their
--     is_owner / is_makler flags say: those are self-declared.
--
-- Nobody is charged for being a makler. Reads are never gated. Server-side
-- writes (the bot's Confirm / Not received, the hold sweep, public holds)
-- carry no auth.uid() and pass; the public page has its own gate below.
--
-- The guards test auth.uid(), not current_user. current_user is the owner
-- inside a SECURITY DEFINER function, so a current_user test would never fire
-- for an app user going through link_manager_by_oikoz_id(); auth.uid() reads
-- the caller's JWT claims and is the same in either context.
--
-- Time is granted in exactly one place: mark_subscription_paid(), which the
-- Edge Functions reach only through the PaymentProvider's markPaid(). The
-- 30-day launch grant below is the one-off exception.
-- ============================================================================

-- ------------------------------------------------------------- tables ----

create table if not exists public.subscriptions (
  user_id              uuid primary key references public.users (id) on delete cascade,
  paid_until           timestamptz,
  -- Set by /subscribe. The bot treats a photo as a receipt only within a day
  -- of it, so ordinary photos sent to the bot are never mistaken for one.
  receipt_requested_at timestamptz,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

create table if not exists public.subscription_payments (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references public.users (id) on delete cascade,
  -- 'manual_paynet' today. 'launch_grant' marks the free period below.
  provider          text not null default 'manual_paynet',
  amount            integer not null check (amount >= 0),           -- UZS
  -- '<user_id>/<payment_id>.<ext>' in the private 'receipts' bucket.
  receipt_file_path text,
  status            text not null default 'pending'
                    check (status in ('pending', 'confirmed', 'rejected')),
  confirmed_by      text,          -- 'telegram:<admin id>', or a provider name
  confirmed_at      timestamptz,
  rejected_by       text,
  rejected_at       timestamptz,
  note              text,
  created_at        timestamptz not null default now()
);

create index if not exists subscription_payments_user_idx
  on public.subscription_payments (user_id, created_at desc);

-- One receipt in review per user: a second screenshot while one is pending is
-- answered by the bot instead of reaching the admin twice.
create unique index if not exists subscription_payments_one_pending
  on public.subscription_payments (user_id)
  where status = 'pending';

-- ---------------------------------------------------------------- RLS ----
-- A user reads their own rows and writes nothing. Every write comes from the
-- Edge Functions as service_role.

alter table public.subscriptions enable row level security;
alter table public.subscription_payments enable row level security;

drop policy if exists subscriptions_select_own on public.subscriptions;
create policy subscriptions_select_own on public.subscriptions
  for select using (user_id = auth.uid());

drop policy if exists subscription_payments_select_own on public.subscription_payments;
create policy subscription_payments_select_own on public.subscription_payments
  for select using (user_id = auth.uid());

revoke all on public.subscriptions from anon;
revoke all on public.subscription_payments from anon;
revoke insert, update, delete, truncate on public.subscriptions from authenticated;
revoke insert, update, delete, truncate on public.subscription_payments from authenticated;
grant select on public.subscriptions to authenticated;
grant select on public.subscription_payments to authenticated;

create or replace function public.subscriptions_touch()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists subscriptions_touch_trg on public.subscriptions;
create trigger subscriptions_touch_trg
  before update on public.subscriptions
  for each row execute function public.subscriptions_touch();

-- ---------------------------------------------------- is this owner paid ----
-- Active while paid_until + 3 days of grace is still ahead. Never paid (no row,
-- or paid_until null) is not active. SECURITY DEFINER so policies and triggers
-- can ask about any user, e.g. a villa's owner on the public page; it answers
-- only yes or no.

create or replace function public.has_active_subscription(p_user_id uuid)
returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(
    (select s.paid_until + interval '3 days' > now()
       from public.subscriptions s
      where s.user_id = p_user_id),
    false
  );
$$;

revoke all on function public.has_active_subscription(uuid) from public;
revoke all on function public.has_active_subscription(uuid) from anon;
grant execute on function public.has_active_subscription(uuid) to authenticated, service_role;

-- ------------------------------------------------------- granting time ----
-- Adds 30 days to a paid_until still in the future -- a double payment
-- extends, never resets -- and otherwise starts 30 days from now. Not callable
-- by anyone directly: only mark_subscription_paid() below calls it.

create or replace function public.grant_subscription_time(p_user_id uuid)
returns timestamptz
language plpgsql security definer set search_path = public as $$
declare
  until timestamptz;
begin
  insert into public.subscriptions as s (user_id, paid_until)
  values (p_user_id, now() + interval '30 days')
  on conflict (user_id) do update
     set paid_until = case
           when s.paid_until > now() then s.paid_until + interval '30 days'
           else now() + interval '30 days'
         end
  returning s.paid_until into until;
  return until;
end $$;

revoke all on function public.grant_subscription_time(uuid) from public;
revoke all on function public.grant_subscription_time(uuid) from anon;
revoke all on function public.grant_subscription_time(uuid) from authenticated;
revoke all on function public.grant_subscription_time(uuid) from service_role;

-- --------------------------------------------- confirming and rejecting ----
-- Same shape as confirm_public_hold() (0020): lock the row, act only on a
-- pending payment, and say what happened so the caller can redraw its message.
--
--   confirmed        time granted; paid_until is the new end
--   rejected         marked rejected; no time granted
--   already_handled  not pending any more; status says how it ended
--   not_found        no such payment for that user
--
-- p_user_id must match the payment: a provider confirms a payment it knows
-- belongs to that user, and a mismatch is treated as not found.

create or replace function public.mark_subscription_paid(
  p_payment_id   uuid,
  p_user_id      uuid,
  p_confirmed_by text
)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  p     public.subscription_payments%rowtype;
  until timestamptz;
begin
  select * into p from public.subscription_payments where id = p_payment_id for update;
  if not found or p.user_id <> p_user_id then
    return jsonb_build_object('outcome', 'not_found');
  end if;

  if p.status <> 'pending' then
    return jsonb_build_object(
      'outcome', 'already_handled',
      'status', p.status,
      'paid_until', (select paid_until from public.subscriptions where user_id = p.user_id)
    );
  end if;

  until := public.grant_subscription_time(p.user_id);

  update public.subscription_payments
     set status = 'confirmed', confirmed_by = p_confirmed_by, confirmed_at = now()
   where id = p.id;

  return jsonb_build_object('outcome', 'confirmed', 'status', 'confirmed', 'paid_until', until);
end $$;

create or replace function public.reject_subscription_payment(
  p_payment_id  uuid,
  p_user_id     uuid,
  p_rejected_by text
)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  p public.subscription_payments%rowtype;
begin
  select * into p from public.subscription_payments where id = p_payment_id for update;
  if not found or p.user_id <> p_user_id then
    return jsonb_build_object('outcome', 'not_found');
  end if;

  if p.status <> 'pending' then
    return jsonb_build_object(
      'outcome', 'already_handled',
      'status', p.status,
      'paid_until', (select paid_until from public.subscriptions where user_id = p.user_id)
    );
  end if;

  update public.subscription_payments
     set status = 'rejected', rejected_by = p_rejected_by, rejected_at = now()
   where id = p.id;

  return jsonb_build_object('outcome', 'rejected', 'status', 'rejected');
end $$;

revoke all on function public.mark_subscription_paid(uuid, uuid, text) from public;
revoke all on function public.mark_subscription_paid(uuid, uuid, text) from anon;
revoke all on function public.mark_subscription_paid(uuid, uuid, text) from authenticated;
grant execute on function public.mark_subscription_paid(uuid, uuid, text) to service_role;

revoke all on function public.reject_subscription_payment(uuid, uuid, text) from public;
revoke all on function public.reject_subscription_payment(uuid, uuid, text) from anon;
revoke all on function public.reject_subscription_payment(uuid, uuid, text) from authenticated;
grant execute on function public.reject_subscription_payment(uuid, uuid, text) to service_role;

-- ------------------------------------------------------- write guard ----
-- One trigger function for every table a villa is changed through. Raises
--
--   oikoz:subscription_required    creating a villa without a subscription
--   oikoz:villa_owner_inactive     changing a villa whose owner has none
--
-- which the app translates.
--
-- SECURITY DEFINER so it always sees the villa's owner, whatever the caller
-- may read. That is safe here, unlike the current_user guards CLAUDE.md warns
-- about: this one decides on auth.uid(), which is the caller's JWT in either
-- context.

create or replace function public.subscription_write_guard()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  actor uuid := auth.uid();
  owner uuid;
  vid   uuid;
begin
  -- Server-side writes (service_role, cron, the SQL Editor) carry no user.
  if actor is null then
    return case when tg_op = 'DELETE' then old else new end;
  end if;

  -- A new villa: the person creating it pays, from now on as its owner.
  if tg_table_name = 'villas' and tg_op = 'INSERT' then
    if not public.has_active_subscription(actor) then
      raise exception 'oikoz:subscription_required — an active Oikoz subscription is needed to add a villa'
        using errcode = 'check_violation';
    end if;
    return new;
  end if;

  if tg_table_name = 'villas' then
    owner := case when tg_op = 'DELETE' then old.owner_id else new.owner_id end;
  else
    vid := case when tg_op = 'DELETE' then old.villa_id else new.villa_id end;
    select v.owner_id into owner from public.villas v where v.id = vid;
  end if;

  if owner is not null and not public.has_active_subscription(owner) then
    raise exception 'oikoz:villa_owner_inactive — this villa is read-only until its owner renews their Oikoz subscription'
      using errcode = 'check_violation';
  end if;

  return case when tg_op = 'DELETE' then old else new end;
end $$;

drop trigger if exists villas_subscription_guard_trg on public.villas;
create trigger villas_subscription_guard_trg
  before insert or update or delete on public.villas
  for each row execute function public.subscription_write_guard();

drop trigger if exists villa_payout_details_subscription_guard_trg on public.villa_payout_details;
create trigger villa_payout_details_subscription_guard_trg
  before insert or update or delete on public.villa_payout_details
  for each row execute function public.subscription_write_guard();

drop trigger if exists villa_managers_subscription_guard_trg on public.villa_managers;
create trigger villa_managers_subscription_guard_trg
  before insert or update or delete on public.villa_managers
  for each row execute function public.subscription_write_guard();

drop trigger if exists bookings_subscription_guard_trg on public.bookings;
create trigger bookings_subscription_guard_trg
  before insert or update or delete on public.bookings
  for each row execute function public.subscription_write_guard();

drop trigger if exists blocked_dates_subscription_guard_trg on public.blocked_dates;
create trigger blocked_dates_subscription_guard_trg
  before insert or update or delete on public.blocked_dates
  for each row execute function public.subscription_write_guard();

-- --------------------------------------------- public page: paused ----
-- A lapsed owner's villa takes no NEW deposit holds. Only create_public_hold()
-- inserts pending rows (bookings_status_guard), so this is the public page's
-- gate. Existing holds and bookings are untouched: confirming, Not received
-- and the sweep are updates, not inserts.

create or replace function public.bookings_paused_guard()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  owner uuid;
begin
  if new.status <> 'pending' then
    return new;
  end if;
  select v.owner_id into owner from public.villas v where v.id = new.villa_id;
  if owner is not null and not public.has_active_subscription(owner) then
    raise exception 'oikoz:bookings_paused' using errcode = 'check_violation';
  end if;
  return new;
end $$;

drop trigger if exists bookings_paused_guard_trg on public.bookings;
create trigger bookings_paused_guard_trg
  before insert on public.bookings
  for each row execute function public.bookings_paused_guard();

-- ------------------------------------------------------ receipts bucket ----
-- Private: receipts show names and card numbers. Only the service role writes;
-- a user may read their own folder. Nothing is ever served publicly.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('receipts', 'receipts', false, 10485760,
        array['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'])
on conflict (id) do update set public = false;

drop policy if exists receipts_select_own on storage.objects;
create policy receipts_select_own on storage.objects
  for select to authenticated
  using (bucket_id = 'receipts' and (storage.foldername(name))[1] = auth.uid()::text);

-- ------------------------------------------------- launch: 30 days free ----
-- Every owner when this FIRST runs -- flagged is_owner, or owning a villa --
-- gets 30 days. Guarded on
-- the table being empty, so re-running the file later never hands free time
-- to owners who joined since. Each grant is also recorded as a 0 UZS
-- 'launch_grant' payment, so /admin shows where the time came from.

do $$
begin
  if not exists (select 1 from public.subscriptions) then
    insert into public.subscriptions (user_id, paid_until)
    select u.id, now() + interval '30 days'
      from public.users u
     where u.is_owner or exists (select 1 from public.villas v where v.owner_id = u.id);

    insert into public.subscription_payments (user_id, provider, amount, status, confirmed_by, confirmed_at, note)
    select u.id, 'launch_grant', 0, 'confirmed', 'migration 0024', now(), '30 days free at launch'
      from public.users u
     where u.is_owner or exists (select 1 from public.villas v where v.owner_id = u.id);
  end if;
end $$;

-- What was granted, for the person running this.
select count(*) as owners_given_30_days_free
  from public.subscription_payments
 where provider = 'launch_grant';
