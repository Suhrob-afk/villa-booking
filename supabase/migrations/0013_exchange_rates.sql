-- ============================================================================
-- Cached exchange rates.
--
-- Per-currency totals stay the ground truth; this only backs the *combined*
-- figure the breakdown and commissions screens show on top of them. One row
-- per currency, holding the Central Bank of Uzbekistan's published rate in
-- UZS per 1 unit.
--
-- The row is refreshed by the exchange-rate Edge Function, which reads
-- through this cache and only calls cbu.uz when the stored rate is no longer
-- from today. Nothing here is ever written by a client.
-- ============================================================================

create table if not exists public.exchange_rates (
  code       text primary key,
  /** UZS per 1 unit of `code`. */
  rate       numeric(18, 4) not null check (rate > 0),
  /** The date the bank published this rate for -- it can lag today by a day. */
  rate_date  date not null,
  fetched_at timestamptz not null default now()
);

alter table public.exchange_rates enable row level security;

-- Readable by any signed-in user; written only by the service role, which
-- bypasses RLS. No insert/update/delete policy exists on purpose.
drop policy if exists exchange_rates_select on public.exchange_rates;
create policy exchange_rates_select on public.exchange_rates
  for select using (auth.uid() is not null);

revoke all on public.exchange_rates from anon;
grant select on public.exchange_rates to authenticated;
