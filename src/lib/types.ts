/**
 * 'pending' is a deposit hold from the public booking page: it occupies its
 * nights only until hold_expires_at. 'expired' is a hold that lapsed, and
 * 'rejected' one the owner turned down from the bot -- neither holds nights,
 * and neither is ever a sale or a cancellation.
 */
export type BookingStatus = 'confirmed' | 'cancelled' | 'pending' | 'expired' | 'rejected'
/** What a booking's price is in. Deposits are always UZS regardless. */
export type BookingCurrency = 'uzs' | 'usd'
export type PricingMode = 'percentage' | 'owner_net'
export type BlockReason = 'owner_use' | 'maintenance' | 'off_market'
export type ClientType =
  | 'family'
  | 'friends_mixed'
  | 'friends_men'
  | 'friends_women'
  | 'couple'
  | 'business'
  | 'other'

/** Display order for the pickers. Labels live in lib/strings.ts, per language. */
export const CLIENT_TYPES: ClientType[] = [
  'family',
  'friends_mixed',
  'friends_men',
  'friends_women',
  'couple',
  'business',
  'other',
]

export const BLOCK_REASONS: BlockReason[] = ['owner_use', 'maintenance', 'off_market']

/** An owner closing off days for something other than a guest booking. */
export interface BlockedDate {
  id: string
  villa_id: string
  /** Half-open like bookings: covers [start_date, end_date). */
  start_date: string
  end_date: string
  reason: BlockReason
  created_by: string | null
  created_at: string
}
export type CommissionStatus = 'unpaid' | 'paid'

export type Lang = 'en' | 'ru' | 'uz'

export interface User {
  id: string
  /** Owners add managers by this. Set by the bot during registration. */
  telegram_id: number
  /** Short human-friendly reference, e.g. oikoz_id0001. Minted for every user. */
  oikoz_id: string
  name: string
  full_name: string | null
  phone: string | null
  language: Lang
  /**
   * A person can be both -- Maklers who also own a villa or two are common --
   * or neither, which means they are a client.
   */
  is_owner: boolean
  is_makler: boolean
  created_at: string
}

export interface Villa {
  id: string
  owner_id: string
  name: string
  location: string | null
  currency: string
  weekday_price: number
  weekend_price: number
  commission_rate: number
  platform_fee_rate: number
  /** Held against damages. Not part of the commission split. */
  deposit_amount: number
  /** Human-friendly reference, e.g. villa_id0001. Display only -- nothing joins on it. */
  villa_code: string
  /**
   * Set once the owner archives it: off the active list, every booking and
   * payout still counted. Null for a live villa.
   */
  archived_at: string | null
  capacity: number | null
  /**
   * Who is credited on this villa's public/channel bookings by default. Null
   * means those bookings credit nobody. The card number is NOT on this row:
   * it lives in villa_payout_details, readable by the owner alone.
   */
  default_channel_makler_id: string | null
  created_at: string
}

export interface Booking {
  id: string
  villa_id: string
  manager_id: string | null
  client_name: string
  client_phone: string | null
  /** The visitor who booked through the public page; null for bookings logged in the app. */
  client_user_id: string | null
  check_in: string
  check_out: string
  /**
   * Chosen per booking; the villa's currency is only the default. total_price,
   * platform_fee, manager_commission, owner_payout and owner_net_amount are
   * all in this currency -- never converted, never summed across currencies.
   */
  currency: BookingCurrency
  total_price: number
  /** Always UZS, whatever `currency` is. */
  deposit_amount: number
  pricing_mode: PricingMode
  client_type: ClientType | null
  /** From the public booking form; null on bookings logged in the app. */
  guests_count: number | null
  /** Whether the CLIENT has paid their deposit -- unrelated to commission_status. */
  deposit_paid: boolean
  /** Only set when pricing_mode is 'owner_net'. */
  owner_net_amount: number | null
  commission_rate_snapshot: number
  manager_commission: number
  platform_fee: number
  owner_payout: number
  commission_status: CommissionStatus
  status: BookingStatus
  /** Set only while status is 'pending'. */
  hold_expires_at: string | null
  /** When the visitor tapped "I've sent the deposit". */
  client_marked_paid_at: string | null
  notes: string | null
  created_at: string
  updated_at: string
}

/** A villa as it appears on Home: plus how the current user is tied to it. */
export interface VillaWithAccess extends Villa {
  access: 'owned' | 'managed'
}
