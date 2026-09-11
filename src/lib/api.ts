import { supabase } from './supabase'
import type {
  BlockedDate,
  BlockReason,
  Booking,
  BookingCurrency,
  ClientType,
  Lang,
  PricingMode,
  User,
  Villa,
  VillaWithAccess,
} from './types'

function unwrap<T>({ data, error }: { data: T | null; error: { message: string } | null }): T {
  if (error) throw new Error(error.message)
  return data as T
}

// -------------------------------------------------------------------- me --

/**
 * The one column a person may change about themselves from the app. RLS scopes
 * the row to the caller and users_update_guard() enforces the column list, so
 * an id other than the signed-in user's simply matches nothing.
 */
export async function updateOwnLanguage(userId: string, language: Lang): Promise<void> {
  const { error } = await supabase.from('users').update({ language }).eq('id', userId)
  if (error) throw new Error(error.message)
}

// ------------------------------------------------------------------ villas --

/**
 * Every villa the user can touch. RLS covers three cases: villas they own,
 * villas they currently manage, and villas they used to manage (kept for
 * their own booking history). owner_id tells us which of "owned"/"managed"
 * to show; a currently-managed vs. formerly-managed villa both read as
 * "managed" here, since the difference only matters inside the villa itself.
 */
export async function fetchVillas(userId: string): Promise<VillaWithAccess[]> {
  const villas = await supabase
    .from('villas')
    .select('*')
    .is('archived_at', null)
    .order('name')
    .then(unwrap<Villa[]>)
  return villas.map((villa) => ({
    ...villa,
    access: villa.owner_id === userId ? 'owned' : 'managed',
  }))
}

export async function fetchVilla(villaId: string): Promise<Villa> {
  return supabase.from('villas').select('*').eq('id', villaId).single().then(unwrap<Villa>)
}

/** villa_code is minted by the database, never sent by the client. */
export type VillaInput = Omit<Villa, 'id' | 'created_at' | 'owner_id' | 'villa_code' | 'archived_at'>

export async function createVilla(ownerId: string, input: VillaInput): Promise<Villa> {
  return supabase.from('villas').insert({ ...input, owner_id: ownerId }).select('*').single().then(unwrap<Villa>)
}

export async function updateVilla(villaId: string, input: VillaInput): Promise<Villa> {
  return supabase.from('villas').update(input).eq('id', villaId).select('*').single().then(unwrap<Villa>)
}

/**
 * Only ever legal on a villa with no bookings -- a database trigger refuses
 * the rest, because villa_id cascades and would take the history with it.
 */
export async function deleteVilla(villaId: string): Promise<void> {
  const { error } = await supabase.from('villas').delete().eq('id', villaId)
  if (error) throw new Error(error.message)
}

/** Archived villas leave the active list; nothing about their data changes. */
export async function fetchArchivedVillas(): Promise<Villa[]> {
  return supabase
    .from('villas')
    .select('*')
    .not('archived_at', 'is', null)
    .order('name')
    .then(unwrap<Villa[]>)
}

export async function setVillaArchived(villaId: string, archived: boolean): Promise<void> {
  const { error } = await supabase
    .from('villas')
    .update({ archived_at: archived ? new Date().toISOString() : null })
    .eq('id', villaId)
  if (error) throw new Error(error.message)
}

/**
 * How much history a villa has, cancellations included -- it decides whether
 * removal means delete or archive. Counted, never fetched.
 */
export async function countVillaBookings(villaId: string): Promise<number> {
  const { count, error } = await supabase
    .from('bookings')
    .select('id', { count: 'exact', head: true })
    .eq('villa_id', villaId)
  if (error) throw new Error(error.message)
  return count ?? 0
}

// ------------------------------------------------------------------- team --

/** Maklers are linked by oikoz_id; telegram_id stays available for support lookups. */
const PUBLIC_USER_COLUMNS = 'id,telegram_id,oikoz_id,name,full_name,phone,language,is_owner,is_makler,created_at'

export async function fetchVillaMaklers(villaId: string): Promise<User[]> {
  const rows = await supabase
    .from('villa_managers')
    .select(`manager:users!villa_managers_manager_id_fkey(${PUBLIC_USER_COLUMNS})`)
    .eq('villa_id', villaId)
    .returns<{ manager: User }[]>()
    .then(unwrap<{ manager: User }[]>)
  return rows.map((row) => row.manager).filter(Boolean)
}

/**
 * Links a makler by their Oikoz reference. The RPC is SECURITY DEFINER: it
 * checks the caller owns the villa, and refuses anyone not registered as a
 * makler. It also tolerates "2", "0002" or "OIKOZ_ID0002" for oikoz_id0002.
 */
export async function linkMakler(villaId: string, oikozId: string): Promise<User> {
  return supabase
    .rpc('link_manager_by_oikoz_id', { p_villa_id: villaId, p_oikoz_id: oikozId })
    .then(unwrap<User>)
}

export async function unlinkMakler(villaId: string, managerId: string): Promise<void> {
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
  /** Null when an owner logs a booking with nobody credited. */
  manager_id: string | null
  client_name: string
  client_phone: string | null
  check_in: string
  check_out: string
  currency: BookingCurrency
  total_price: number
  deposit_amount: number
  pricing_mode: PricingMode
  owner_net_amount: number | null
  client_type: ClientType | null
  deposit_paid: boolean
  notes: string | null
}

export async function createBooking(input: BookingInput): Promise<Booking> {
  return supabase.from('bookings').insert(input).select('*').single().then(unwrap<Booking>)
}

export async function updateBooking(
  bookingId: string,
  input: Omit<BookingInput, 'villa_id'>,
): Promise<Booking> {
  return supabase.from('bookings').update(input).eq('id', bookingId).select('*').single().then(unwrap<Booking>)
}

export async function setBookingStatus(bookingId: string, status: 'confirmed' | 'cancelled'): Promise<Booking> {
  return supabase.from('bookings').update({ status }).eq('id', bookingId).select('*').single().then(unwrap<Booking>)
}

/** Owners mark the client's deposit as received (or not) after the fact. */
export async function setDepositPaid(bookingId: string, deposit_paid: boolean): Promise<Booking> {
  return supabase
    .from('bookings')
    .update({ deposit_paid })
    .eq('id', bookingId)
    .select('*')
    .single()
    .then(unwrap<Booking>)
}

/**
 * Resolves an oikoz reference to a makler so an owner can credit someone who
 * has no standing link to this villa. SECURITY DEFINER and gated on villa
 * ownership, so the sequential codes are not enumerable.
 */
export async function findMaklerForVilla(
  villaId: string,
  oikozId: string,
): Promise<{ id: string; oikoz_id: string; name: string }> {
  const rows = await supabase
    .rpc('find_makler_for_villa', { p_villa_id: villaId, p_oikoz_id: oikozId })
    .then(unwrap<{ id: string; oikoz_id: string; name: string }[]>)
  const match = rows?.[0]
  if (!match) throw new Error(`No makler has the reference ${oikozId}`)
  return match
}

/** Is this user a standing makler on the villa, as opposed to its owner? */
export async function isAssignedMakler(villaId: string, userId: string): Promise<boolean> {
  const rows = await supabase
    .from('villa_managers')
    .select('villa_id')
    .eq('villa_id', villaId)
    .eq('manager_id', userId)
    .then(unwrap<{ villa_id: string }[]>)
  return rows.length > 0
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

export interface BookingWithVilla extends Booking {
  villa: Pick<Villa, 'id' | 'name' | 'currency'>
}

/**
 * Every confirmed booking the user can see, with its villa attached for the
 * name and currency. RLS scopes it to villas they own or are assigned to, so
 * the breakdown screen can filter to one villa client-side without a second
 * round trip.
 */
export async function fetchConfirmedBookingsWithVilla(): Promise<BookingWithVilla[]> {
  return supabase
    .from('bookings')
    .select('*, villa:villas!bookings_villa_id_fkey(id,name,currency)')
    .eq('status', 'confirmed')
    .order('check_in', { ascending: false })
    .returns<BookingWithVilla[]>()
    .then(unwrap<BookingWithVilla[]>)
}

// -------------------------------------------------------------- blocks --

export async function fetchBlockedDates(villaId: string): Promise<BlockedDate[]> {
  return supabase
    .from('blocked_dates')
    .select('*')
    .eq('villa_id', villaId)
    .order('start_date')
    .then(unwrap<BlockedDate[]>)
}

/** Owner-only: RLS rejects anyone else, and a trigger rejects clashing dates. */
export async function createBlock(input: {
  villa_id: string
  start_date: string
  end_date: string
  reason: BlockReason
  created_by: string
}): Promise<BlockedDate> {
  return supabase.from('blocked_dates').insert(input).select('*').single().then(unwrap<BlockedDate>)
}

export async function deleteBlock(blockId: string): Promise<void> {
  const { error } = await supabase.from('blocked_dates').delete().eq('id', blockId)
  if (error) throw new Error(error.message)
}

// ------------------------------------------------------------ commissions --

export interface CommissionRow extends Booking {
  villa: Pick<Villa, 'id' | 'name' | 'currency' | 'owner_id'>
  manager: Pick<User, 'id' | 'name' | 'oikoz_id'> | null
}

/**
 * Confirmed bookings with the villa (for currency) and makler attached.
 * RLS decides the scope: a makler gets their own bookings (including on
 * villas they've since been unassigned from), an owner gets every booking
 * on the villas they own.
 */
export async function fetchCommissionRows(): Promise<CommissionRow[]> {
  return supabase
    .from('bookings')
    .select('*, villa:villas!bookings_villa_id_fkey(id,name,currency,owner_id), manager:users!bookings_manager_id_fkey(id,name,oikoz_id)')
    .eq('status', 'confirmed')
    .order('check_in', { ascending: false })
    .returns<CommissionRow[]>()
    .then(unwrap<CommissionRow[]>)
}
