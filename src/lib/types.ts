export type Role = 'owner' | 'manager'
export type BookingStatus = 'confirmed' | 'cancelled'
export type CommissionStatus = 'unpaid' | 'paid'

export interface User {
  id: string
  telegram_id: number
  name: string
  phone: string | null
  role: Role
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
  capacity: number | null
  created_at: string
}

export interface Booking {
  id: string
  villa_id: string
  manager_id: string | null
  client_name: string
  client_phone: string | null
  check_in: string
  check_out: string
  total_price: number
  commission_rate_snapshot: number
  manager_commission: number
  platform_fee: number
  owner_payout: number
  commission_status: CommissionStatus
  status: BookingStatus
  notes: string | null
  created_at: string
  updated_at: string
}

/** A villa as it appears on Home: plus how the current user is tied to it. */
export interface VillaWithAccess extends Villa {
  access: 'owned' | 'managed'
}
