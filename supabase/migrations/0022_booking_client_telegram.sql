-- ============================================================================
-- The client's Telegram identity on the owner's booking card.
--
-- Tapping a booked night on the villa calendar opens a small card about that
-- booking. For a booking made on the public page it shows the guest's
-- Telegram name, linked to t.me/<username> when they have one. Two things
-- stood in the way:
--
--   1. The username was never stored. telegram-auth sees it in the verified
--      initData on every sign-in and now saves it to users.telegram_username.
--      Existing users get it the next time they open the Mini App.
--
--   2. RLS hides the guest's users row from the owner: users_select covers
--      yourself and owner<->makler pairs only (is_related_user), and a guest
--      from the booking link is neither. villa_booking_clients() below hands
--      out just the name and username, and only for bookings the caller can
--      already see.
--
-- Additive: one nullable column, one new function, and users_update_guard()
-- redefined with the new column added to what a user may not change about
-- themselves (put it back from 0016 to undo that part).
-- ============================================================================

-- --------------------------------------------- users: telegram username ----
-- Without the leading @. Null for someone with no username, and for anyone
-- who has not opened the Mini App since this was added.

alter table public.users add column if not exists telegram_username text;

-- ---------------------------------------------------- update guardrail ----
-- As in 0016, plus telegram_username. It comes from Telegram's signed
-- initData, so only telegram-auth (service role) writes it. Were a user able
-- to set their own, they could point an owner's "message this guest" link at
-- somebody else.

create or replace function public.users_update_guard()
returns trigger language plpgsql security invoker set search_path = public as $$
begin
  -- Only end-user traffic is restricted. The bot webhook and telegram-auth run
  -- as service_role and legitimately write roles, oikoz_id and the profile
  -- during onboarding, /role and /language.
  if current_user <> 'authenticated' then
    return new;
  end if;

  if new.id                   is distinct from old.id
     or new.telegram_id       is distinct from old.telegram_id
     or new.telegram_username is distinct from old.telegram_username
     or new.oikoz_id          is distinct from old.oikoz_id
     or new.role              is distinct from old.role
     or new.is_owner          is distinct from old.is_owner
     or new.is_makler         is distinct from old.is_makler
     or new.created_at        is distinct from old.created_at
  then
    raise exception 'Only name, full name, phone and language can be changed';
  end if;

  return new;
end $$;

-- ------------------------------------------- the guest behind a booking ----
-- For every booking on the villa that came from the public page
-- (client_user_id set): the guest's Telegram name and username. Nothing else
-- from their users row -- not their phone (the booking carries the one they
-- booked with), oikoz_id, language or anything to do with other villas.
--
-- Gated exactly like bookings_select: the villa's owner, or a makler assigned
-- to it. Anyone else gets no rows.
--
-- users.name is the Telegram display name for a guest registered from the
-- booking link. For someone who went through the bot's onboarding it is the
-- full name they typed there, which is what they chose to be called.

create or replace function public.villa_booking_clients(p_villa_id uuid)
returns table (booking_id uuid, telegram_name text, telegram_username text)
language sql stable security definer set search_path = public as $$
  select b.id, u.name, u.telegram_username
    from public.bookings b
    join public.users u on u.id = b.client_user_id
   where b.villa_id = p_villa_id
     and (public.is_villa_owner(p_villa_id) or public.is_villa_manager(p_villa_id));
$$;

revoke all on function public.villa_booking_clients(uuid) from public;
revoke all on function public.villa_booking_clients(uuid) from anon;
grant execute on function public.villa_booking_clients(uuid) to authenticated;
