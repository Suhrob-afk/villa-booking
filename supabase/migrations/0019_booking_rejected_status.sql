-- ============================================================================
-- Booking status 'rejected': the villa owner turned down a deposit hold from
-- the public booking page (the Reject button in the bot's message).
--
-- Like 'expired', it holds no nights and is deliberately NOT 'cancelled': the
-- Dashboard Overview counts cancellations as a figure of their own, and a hold
-- the owner refused was never a sale.
--
-- This file must run ON ITS OWN, before 0020. Postgres refuses to use an enum
-- value in the same transaction that added it, and the SQL Editor runs a whole
-- script as one transaction.
-- ============================================================================

alter type public.booking_status add value if not exists 'rejected';
