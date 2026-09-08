-- ============================================================================
-- Archiving a villa.
--
-- An owner needs a way to take a villa off their list. Deleting one is only
-- safe while it has no history: bookings.villa_id is ON DELETE CASCADE, so
-- dropping a villa that has been booked would silently take its bookings --
-- and every payout and commission attributed to them -- with it.
--
-- So: no history, real delete. Any history, archive instead. Archiving is a
-- timestamp and nothing else, which means the rows stay exactly where they
-- are and keep counting towards revenue totals.
-- ============================================================================

alter table public.villas add column if not exists archived_at timestamptz;

create index if not exists villas_active_idx
  on public.villas (owner_id) where archived_at is null;

-- ------------------------------------------------- deletion guardrail ----
-- The UI offers archive instead of delete once a villa has bookings, but the
-- cascade is destructive enough that it should not depend on the client
-- getting it right.

create or replace function public.villas_delete_guard()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  booking_count integer;
begin
  -- Only end-user traffic is restricted; service_role keeps an escape hatch
  -- for genuine administrative cleanup, same as users_update_guard().
  if current_user <> 'authenticated' then
    return old;
  end if;

  select count(*) into booking_count from public.bookings where villa_id = old.id;

  if booking_count > 0 then
    raise exception
      'This villa has % booking(s) in its history — archive it instead of deleting it', booking_count
      using errcode = 'check_violation';
  end if;

  return old;
end $$;

drop trigger if exists villas_delete_guard_trg on public.villas;
create trigger villas_delete_guard_trg
  before delete on public.villas
  for each row execute function public.villas_delete_guard();
