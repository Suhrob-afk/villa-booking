-- ============================================================================
-- Make users_update_guard() and villas_delete_guard() actually run.
--
-- Both were created SECURITY DEFINER and both begin with
--
--     if current_user <> 'authenticated' then return ...; end if;
--
-- Inside a SECURITY DEFINER function, current_user is the function's OWNER
-- (postgres), not the role that issued the statement -- that is documented
-- Postgres behaviour. So the test was always true and both guards returned
-- before checking anything:
--
--   * users_update_guard  -- a signed-in client could PATCH their own users
--                            row with {"is_owner": true} or {"is_makler":
--                            true}, the hole 0010 set out to close.
--   * villas_delete_guard -- an owner could delete a villa that has bookings,
--                            and the ON DELETE CASCADE would take its whole
--                            booking history with it.
--
-- Neither function needs elevated privileges: the first only compares OLD and
-- NEW, and the second counts bookings on a villa the caller owns, which
-- bookings_select already lets them see. Switching both to SECURITY INVOKER
-- makes current_user the real caller, so the service-role and SQL Editor
-- escape hatches keep working exactly as their comments intended.
--
-- Also: villas_delete_guard now ignores expired holds. A visitor's lapsed hold
-- on the public page is not history, and should not stop an owner deleting a
-- villa that never had a real booking. (The cascade removes those rows.)
--
-- Reversible: re-run the function bodies from 0010 / 0011.
-- ============================================================================

create or replace function public.users_update_guard()
returns trigger language plpgsql security invoker set search_path = public as $$
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

create or replace function public.villas_delete_guard()
returns trigger language plpgsql security invoker set search_path = public as $$
declare
  booking_count integer;
begin
  -- Only end-user traffic is restricted; service_role keeps an escape hatch
  -- for genuine administrative cleanup, same as users_update_guard().
  if current_user <> 'authenticated' then
    return old;
  end if;

  select count(*) into booking_count
    from public.bookings
   where villa_id = old.id
     and status <> 'expired';

  if booking_count > 0 then
    raise exception
      'This villa has % booking(s) in its history — archive it instead of deleting it', booking_count
      using errcode = 'check_violation';
  end if;

  return old;
end $$;
