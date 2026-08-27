/** Currencies people actually use for these villas; extend freely. */
export const CURRENCIES = ['USD', 'UZS', 'EUR', 'RUB', 'KZT'] as const

const ZERO_DECIMAL = new Set(['UZS', 'KZT', 'JPY', 'KRW'])

export function formatMoney(amount: number, currency: string): string {
  const fractionDigits = ZERO_DECIMAL.has(currency) ? 0 : 2
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency,
      minimumFractionDigits: fractionDigits,
      maximumFractionDigits: fractionDigits,
    }).format(amount)
  } catch {
    return `${amount.toFixed(fractionDigits)} ${currency}`
  }
}

export function formatPercent(rate: number): string {
  return `${round(rate * 100, 2)}%`
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}
