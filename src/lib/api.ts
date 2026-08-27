import { supabase } from './supabase'
import type { Booking, User, Villa, VillaWithAccess } from './types'

function unwrap<T>({ data, error }: { data: T | null; error: { message: string } | null }): T {
  if (error) throw new Error(error.message)
  return data as T
}

// ------------------------------------------------------------------ villas --

/**
 * Every villa the user can touch. RLS already limits the rows to villas they
 * own plus villas they are linked to through villa_managers, so owner_id alone
 * tells us which of the two a row is.
 */
export async function fetchVillas(userId: string): Promise<VillaWithAccess[]> {
  const villas = await supabase.from('villas').select('*').order('name').then(unwrap<Villa[]>)
  return villas.map((villa) => ({
    ...villa,
    access: villa.owner_id === userId ? 'owned' : 'managed',
  }))
}

export async function fetchVilla(villaId: string): Promise<Villa> {
  return supabase.from('villas').select('*').eq('id', villaId).single().then(unwrap<Villa>)
}

export type VillaInput = Omit<Villa, 'id' | 'created_at' | 'owner_id'>

export async function createVilla(ownerId: string, input: VillaInput): Promise<Villa> {
  return supabase.from('villas').insert({ ...input, owner_id: ownerId }).select('*').single().then(unwrap<Villa>)
}

export async function updateVilla(villaId: string, input: VillaInput): Promise<Villa> {
  return supabase.from('villas').update(input).eq('id', villaId).select('*').single().then(unwrap<Villa>)
}

export async function deleteVilla(villaId: string): Promise<void> {
  const { error } = await supabase.from('villas').delete().eq('id', villaId)
  if (error) throw new Error(error.message)
}

// ------------------------------------------------------------------- team --

export async function fetchVillaManagers(villaId: string): Promise<User[]> {
  const rows = await supabase
    .from('villa_managers')
    .select('manager:users!villa_managers_manager_id_fkey(*)')
    .eq('villa_id', villaId)
    .returns<{ manager: User }[]>()
    .then(unwrap<{ manager: User }[]>)
  return rows.map((row) => row.manager).filter(Boolean)
}

export async function linkManager(villaId: string, telegramId: number): Promise<User> {
  return supabase
    .rpc('link_manager_by_telegram_id', { p_villa_id: villaId, p_telegram_id: telegramId })
    .then(unwrap<User>)
}

export async function unlinkManager(villaId: string, managerId: string): Promise<void> {
  const { error } = await supabase
    .from('villa_managers')
    .delete()
    .eq('villa_id', villaId)
    .eq('manager_id', managerId)
  if (error) throw new Error(error.message)
}

// --------------------------------------------------------------- bookings --

export async function fetchBookings(villaId: string): Promise<Booking[]> {
  return supabase
    .from('bookings')
    .select('*')
    .eq('villa_id', villaId)
    .order('check_in')
    .then(unwrap<Booking[]>)
}

export async function fetchBooking(bookingId: string): Promise<Booking> {
  return supabase.from('bookings').select('*').eq('id', bookingId).single().then(unwrap<Booking>)
}

export interface BookingInput {
  villa_id: string
  manager_id: string
  client_name: string
  client_phone: string | null
  check_in: string
  check_out: string
  total_price: number
  notes: string | null
}

export async function createBooking(input: BookingInput): Promise<Booking> {
  return supabase.from('bookings').insert(input).select('*').single().then(unwrap<Booking>)
}

export async function updateBooking(bookingId: string, input: Omit<BookingInput, 'villa_id' | 'manager_id'>): Promise<Booking> {
  return supabase.from('bookings').update(input).eq('id', bookingId).select('*').single().then(unwrap<Booking>)
}

export async function setBookingStatus(bookingId: string, status: 'confirmed' | 'cancelled'): Promise<Booking> {
  return supabase.from('bookings').update({ status }).eq('id', bookingId).select('*').single().then(unwrap<Booking>)
}

export async function setCommissionStatus(bookingId: string, commission_status: 'paid' | 'unpaid'): Promise<Booking> {
  return supabase
    .from('bookings')
    .update({ commission_status })
    .eq('id', bookingId)
    .select('*')
    .single()
    .then(unwrap<Booking>)
}

// ------------------------------------------------------------ commissions --

export interface CommissionRow extends Booking {
  villa: Pick<Villa, 'id' | 'name' | 'currency' | 'owner_id'>
  manager: Pick<User, 'id' | 'name' | 'telegram_id'> | null
}

/**
 * Confirmed bookings with the villa (for currency) and manager attached.
 * RLS decides the scope: a manager gets their own bookings, an owner gets
 * every booking on the villas they own.
 */
export async function fetchCommissionRows(): Promise<CommissionRow[]> {
  return supabase
    .from('bookings')
    .select('*, villa:villas!bookings_villa_id_fkey(id,name,currency,owner_id), manager:users!bookings_manager_id_fkey(id,name,telegram_id)')
    .eq('status', 'confirmed')
    .order('check_in', { ascending: false })
    .returns<CommissionRow[]>()
    .then(unwrap<CommissionRow[]>)
}
