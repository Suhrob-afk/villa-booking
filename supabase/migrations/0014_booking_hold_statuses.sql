-- ============================================================================
-- Booking hold statuses: 'pending' and 'expired'.
--
--   pending -- a visitor on the public booking page is holding these dates
--              while they transfer the deposit. Blocks the dates until
--              hold_expires_at (added in 0015).
--   expired -- a hold that lapsed unconfirmed. Holds no nights, and is
--              deliberately NOT 'cancelled': the Dashboard Overview counts
--              cancellations as a figure of their own, and a hold that ran out
--              was never a sale to begin with.
--
-- This file must run ON ITS OWN, before 0015. Postgres refuses to use an enum
-- value in the same transaction that added it, and the SQL Editor runs a whole
-- script as one transaction.
-- ============================================================================

alter type public.booking_status add value if not exists 'pending';
alter type public.booking_status add value if not exists 'expired';
