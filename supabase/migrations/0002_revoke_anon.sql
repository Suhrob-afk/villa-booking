-- ============================================================================
-- Strip the anon role back to nothing in public.
--
-- Supabase's default privileges grant anon SELECT on new tables and EXECUTE on
-- new functions. RLS still blocks anon from reading rows, and every RPC checks
-- auth.uid() for itself, so nothing was reachable — but that made RLS the only
-- thing standing between an unauthenticated caller and the data. One careless
-- `using (true)` policy later and that stops being true.
--
-- This app has no anonymous surface at all: the anon key is used solely as the
-- apikey header on the telegram-auth Edge Function call, which never touches
-- PostgREST. So anon gets nothing here.
-- ============================================================================

revoke all on public.users          from anon;
revoke all on public.villas         from anon;
revoke all on public.villa_managers from anon;
revoke all on public.bookings       from anon;

revoke all on function public.link_manager_by_telegram_id(uuid, bigint) from anon;
revoke all on function public.is_villa_owner(uuid)     from anon;
revoke all on function public.is_villa_manager(uuid)   from anon;
revoke all on function public.is_related_user(uuid)    from anon;
revoke all on function public.current_role_is(user_role) from anon;
