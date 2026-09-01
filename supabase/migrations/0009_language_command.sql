-- ============================================================================
-- /language — a step of its own, so the language callback can tell a change
-- of preference from the first question of onboarding.
-- ============================================================================

alter table public.bot_onboarding_state drop constraint if exists bot_onboarding_state_step_check;
alter table public.bot_onboarding_state
  add constraint bot_onboarding_state_step_check
  check (step in (
    'language', 'phone', 'full_name', 'identity', 'role_update', 'language_update', 'done'
  ));
