-- ============================================================================
-- Let a person change their own language from the Mini App.
--
-- The app now has a language switcher that writes public.users.language, the
-- same column the bot's /language command sets, so whichever surface someone
-- used last is what both speak.
--
-- users_update_guard() is rewritten from a denylist to an allowlist while we
-- are here. The original listed the three columns that existed in 0001 (id,
-- telegram_id, role); is_owner, is_makler and oikoz_id arrived later in 0003
-- and were never added to it, so a signed-in client could PATCH
-- /rest/v1/users?id=eq.<self> with {"is_owner": true} and grant themselves
-- owner rights. Naming what MAY change instead of what may not closes that and
-- keeps any future column locked down by default.
--
-- Self-editable, and nothing else: name, full_name, phone, language.
-- ============================================================================

create or replace function public.users_update_guard()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  -- Only end-user traffic is restricted. The bot webhook and telegram-auth run
  -- as service_role and legitimately write roles, oikoz_id and the profile
  -- during onboarding, /role and /language.
  if current_user <> 'authenticated' then
    return new;
  end if;

  if new.id            is distinct from old.id
     or new.telegram_id is distinct from old.telegram_id
     or new.oikoz_id    is distinct from old.oikoz_id
     or new.role        is distinct from old.role
     or new.is_owner    is distinct from old.is_owner
     or new.is_makler   is distinct from old.is_makler
     or new.created_at  is distinct from old.created_at
  then
    raise exception 'Only name, full name, phone and language can be changed';
  end if;

  return new;
end $$;

-- Recreated so the trigger points at the new definition even on a database
-- where 0001 already ran.
drop trigger if exists users_update_guard_trg on public.users;
create trigger users_update_guard_trg
  before update on public.users
  for each row execute function public.users_update_guard();

-- The language check constraint from 0003 still rejects anything outside
-- ('en','ru','uz'), so a bad value fails at the database rather than silently
-- leaving the app in a language it has no strings for.
