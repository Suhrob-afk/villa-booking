import { isWeekend, nightsBetween } from './dates'
import type { PricingMode, Villa } from './types'

export interface Quote {
  nights: number
  weekdayNights: number
  weekendNights: number
  suggestedTotal: number
}

/**
 * Prices a range at the villa's own weekday/weekend rates. The manager can
 * overwrite the total afterwards — this only pre-fills the field.
 */
export function quoteRange(villa: Pick<Villa, 'weekday_price' | 'weekend_price'>, checkIn: string, checkOut: string): Quote {
  const empty: Quote = { nights: 0, weekdayNights: 0, weekendNights: 0, suggestedTotal: 0 }
  if (!checkIn || !checkOut || checkOut <= checkIn) return empty

  let weekdayNights = 0
  let weekendNights = 0
  for (const night of nightsBetween(checkIn, checkOut)) {
    if (isWeekend(night)) weekendNights++
    else weekdayNights++
  }

  return {
    nights: weekdayNights + weekendNights,
    weekdayNights,
    weekendNights,
    suggestedTotal: round2(weekdayNights * villa.weekday_price + weekendNights * villa.weekend_price),
  }
}

export interface Split {
  platformFee: number
  managerCommission: number
  ownerPayout: number
}

/**
 * Mirrors the bookings_compute() trigger exactly, so the live preview in the
 * form matches what the database will store.
 *
 * percentage: the makler takes a cut of the total, the owner gets the rest.
 * owner_net:  the owner's figure is fixed and the makler keeps the spread.
 */
export function splitTotal(
  total: number,
  commissionRate: number,
  platformFeeRate: number,
  mode: PricingMode = 'percentage',
  ownerNet = 0,
): Split {
  const safeTotal = Number.isFinite(total) ? total : 0
  const platformFee = round2(safeTotal * platformFeeRate)

  if (mode === 'owner_net') {
    const safeNet = Number.isFinite(ownerNet) ? ownerNet : 0
    return {
      platformFee,
      managerCommission: round2(safeTotal - safeNet - platformFee),
      ownerPayout: round2(safeNet),
    }
  }

  const managerCommission = round2(safeTotal * commissionRate)
  return {
    platformFee,
    managerCommission,
    ownerPayout: round2(safeTotal - platformFee - managerCommission),
  }
}

export function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100
}
