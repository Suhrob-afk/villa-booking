-- ============================================================================
-- The name on the owner's payout card.
--
-- A guest paying the deposit types the owner's card number into their banking
-- app, which then shows whose card it is. The booking page now shows the name
-- the owner gave next to the number, so the guest can check the two match.
--
-- Requires 0015 (villa_payout_details) and 0024. Additive: one nullable
-- column, one check constraint, one trigger.
--
-- WHO CAN READ IT. Exactly who can read the card number: the column is on
-- villa_payout_details, whose only policies (0015) are the villa owner's.
-- Maklers, guests and other owners get nothing through the app's queries.
-- The public booking page receives it from get-public-villa,
-- create-public-booking and mark-deposit-sent (service role), and only on the
-- guest's own live hold that is not yet marked paid -- the same rule as the
-- number.
--
-- EXISTING CARDS. Rows from before this file have no name, and keep working:
-- the page shows their number alone, and the owner is nudged to add the name.
-- The rule below applies only when a card is set, changed, or its name
-- cleared.
-- ============================================================================

alter table public.villa_payout_details add column if not exists card_holder_name text;

do $$ begin
  alter table public.villa_payout_details
    add constraint villa_payout_card_holder_name_length
    check (card_holder_name is null or char_length(card_holder_name) between 1 and 100);
exception when duplicate_object then null; end $$;

-- --------------------------------------------------- name guardrail ----
-- Tidies the name (trims it and collapses runs of spaces; letter case is kept
-- -- banking apps often show names in capitals) and refuses a card without one:
--
--   * inserting a card
--   * changing a card's number
--   * clearing a name that was set
--
-- all need a name. An existing card with no name may stay as it is.
-- Raised as 'oikoz:card_name_required' for the app to translate.
--
-- Like the booking guards, the rule restrains app users -- owners saving
-- their card in Villa Setup -- and not server-side or SQL Editor writes (no
-- server code writes payout cards; the older verify scripts' fixtures do).
-- SECURITY INVOKER, so current_user is the role that issued the write. The
-- tidying applies to every writer.

create or replace function public.villa_payout_details_card_name()
returns trigger language plpgsql security invoker set search_path = public as $$
begin
  new.card_holder_name := nullif(btrim(regexp_replace(coalesce(new.card_holder_name, ''), '\s+', ' ', 'g')), '');

  if current_user = 'authenticated'
     and new.card_holder_name is null
     and (tg_op = 'INSERT'
          or new.card_number is distinct from old.card_number
          or old.card_holder_name is not null)
  then
    raise exception 'oikoz:card_name_required' using errcode = 'check_violation';
  end if;

  return new;
end $$;

-- Postgres runs a table's BEFORE triggers in name order. This one's name puts
-- it after villa_payout_details_subscription_guard_trg (0024), so an owner
-- whose subscription has lapsed is told that, not asked for a name first.

drop trigger if exists villa_payout_details_tidy_name_trg on public.villa_payout_details;
create trigger villa_payout_details_tidy_name_trg
  before insert or update on public.villa_payout_details
  for each row execute function public.villa_payout_details_card_name();
