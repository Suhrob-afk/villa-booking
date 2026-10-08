-- ============================================================================
-- Scheduled cleanup of expired booking holds (pg_cron).
--
-- The first scheduled job in this project. Every two minutes it releases
-- every pending hold whose hold_expires_at has passed, so lapsed holds leave
-- calendars even when nobody is writing to that villa. Writes do not depend
-- on it: bookings_release_holds (0015) sweeps a villa before any booking
-- lands on it. See the design note in 0015.
--
-- Requires 0015. Safe to re-run: cron.schedule() with an existing job name
-- replaces that job rather than adding a second one.
--
-- To undo:  select cron.unschedule('oikoz-release-expired-holds');
-- ============================================================================

-- Shows the installed extension, if any -- empty means it is not enabled.
select extname, extversion from pg_extension where extname = 'pg_cron';

do $$ begin
  if not exists (select 1 from pg_extension where extname = 'pg_cron') then
    raise exception 'pg_cron is not enabled. Enable it under Database -> Extensions, then re-run this file.';
  end if;
end $$;

select cron.schedule(
  'oikoz-release-expired-holds',
  '*/2 * * * *',
  $$select public.release_expired_holds()$$
);

-- The job as it is now scheduled.
select jobid, jobname, schedule, command, active
  from cron.job
 where jobname = 'oikoz-release-expired-holds';
