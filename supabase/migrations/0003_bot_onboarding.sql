-- ============================================================================
-- Bot onboarding: the Telegram conversation that runs BEFORE the Mini App.
--
-- Adds the profile fields the bot collects, a per-user conversation state
-- table, and the OKZ reference id. Nothing here changes how telegram-auth or
-- the Mini App screens behave.
-- ============================================================================

-- ------------------------------------------------------ users: profile ----

alter table public.users add column if not exists language  text not null default 'en';
alter table public.users add column if not exists full_name text;
alter table public.users add column if not exists is_owner  boolean not null default false;
alter table public.users add column if not exists is_makler boolean not null default false;

do $$ begin
  alter table public.users
    add constraint users_language_supported check (language in ('en', 'ru', 'uz'));
exception when duplicate_object then null; end $$;

-- `role` stays NOT NULL and keeps driving the existing RLS policies and the
-- Mini App's owner/manager branching. The bot derives it from the identity
-- choice so both models stay in agreement:
--
--   Villa Owner   -> is_owner,              role 'owner'
--   Makler        -> is_makler,             role 'manager'
--   Both          -> is_owner + is_makler,  role 'owner'
--   Just browsing -> neither,               role 'manager'  (an empty,
--                                           harmless view until an owner
--                                           links them to a villa)
--
-- is_owner/is_makler are the source of truth for anything new; `role` is the
-- compatibility shadow for what already exists.

-- ------------------------------------------------------- users: OKZ id ----
-- Every user gets one, whatever they pick — including users created by
-- telegram-auth, since this is a column DEFAULT rather than bot-side logic.

create sequence if not exists public.oikoz_id_seq;

alter table public.users add column if not exists oikoz_id text;

alter table public.users
  alter column oikoz_id set default 'OKZ-' || lpad(nextval('public.oikoz_id_seq')::text, 4, '0');

update public.users set oikoz_id = default where oikoz_id is null;

alter table public.users alter column oikoz_id set not null;

create unique index if not exists users_oikoz_id_key on public.users (oikoz_id);

-- --------------------------------------------- bot conversation state ----

create table if not exists public.bot_onboarding_state (
  telegram_id bigint primary key,
  step        text not null default 'language'
              check (step in ('language', 'phone', 'full_name', 'identity', 'done')),
  language    text check (language is null or language in ('en', 'ru', 'uz')),
  phone       text,
  full_name   text,
  updated_at  timestamptz not null default now()
);

-- Only the webhook (service role) ever reads or writes this. RLS is on with
-- no policies at all, so every other role is denied by default.
alter table public.bot_onboarding_state enable row level security;
revoke all on public.bot_onboarding_state from anon;
revoke all on public.bot_onboarding_state from authenticated;

-- -------------------------------------------------- manager linking fix ----
-- link_manager_by_telegram_id() gated on role = 'manager'. A user who picks
-- "Both" in the bot gets role 'owner', so an owner could never link them to a
-- villa. Accept is_makler as well: strictly wider, and it keeps the RPC
-- agreeing with the new source of truth.

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
  if target.role <> 'manager' and not target.is_makler then
    raise exception '% is not registered as a manager', coalesce(nullif(target.name, ''), p_telegram_id::text);
  end if;

  insert into public.villa_managers (villa_id, manager_id)
  values (p_villa_id, target.id)
  on conflict do nothing;

  return target;
end $$;

revoke all on function public.link_manager_by_telegram_id(uuid, bigint) from public;
revoke all on function public.link_manager_by_telegram_id(uuid, bigint) from anon;
grant execute on function public.link_manager_by_telegram_id(uuid, bigint) to authenticated;
