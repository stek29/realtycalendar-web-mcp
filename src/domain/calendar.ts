// Availability for a stay (spec §2.2). Pure: grid, stay rules and prices come in as arguments.
import { fromGridEvent, sortBookings, type BookingSummary } from './bookings.js'
import type { Catalog, Category } from './catalog.js'
import { addDays, nights as nightsOf } from './dates.js'
import type { Grid, GridEvent, SpecialPrice, StayRules } from '../upstream/schemas.js'

export type NightState = 'free' | 'booked' | 'hold' | 'closed'

export interface Run {
  from: string
  to: string
  state: NightState
  booking_id?: number
  guest_name?: string | null
}

export interface RoomAvailability {
  room: string
  room_id: number
  bookable: boolean
  reason: 'booked' | 'closed' | 'category_full' | null
  runs: Run[]
}

export interface StayRuleRun {
  from: string
  to: string
  min_stay: number | null
  no_arrival: boolean
  no_departure: boolean
}

export interface CategoryAvailability {
  category: string
  category_id: number
  single_unit: boolean
  capacity: number
  max_guests: number
  bookable_count: number
  bookable_rooms: string[]
  empty_rooms: string[]
  held_rooms: string[]
  price_total: number | null
  price_per_night: number | null
  stay_rules: { min_stay: number | null; stay_ok: boolean; problems: string[]; runs: StayRuleRun[] }
  unassigned?: BookingSummary[]
  rooms?: RoomAvailability[]
  unit_runs?: Run[]
}

export interface AvailabilityInput {
  catalog: Catalog
  categories: Category[]
  grid: Grid
  stayRules: StayRules
  /** RC quote for the whole stay per category id; missing → null. */
  prices: ReadonlyMap<number, number>
  checkIn: string
  checkOut: string
  detail: 'summary' | 'rooms'
  /** Limit `rooms` to this room (detail = rooms). */
  roomId?: number
}

type Row = Grid['items'][number]

const covers = (x: { begin_date: string; end_date: string }, night: string) =>
  x.begin_date <= night && night < x.end_date
const closedOn = (prices: SpecialPrice[], night: string) =>
  prices.some((p) => p.closed && !p.is_delete && covers(p, night))
const active = (e: GridEvent) => !e.is_delete && (e.status === 'booked' || e.status === 'request')

/** What a grid row (a room, or a single-unit category) holds on one night. */
function nightOf(row: Row | undefined, night: string): { state: NightState; event?: GridEvent } {
  if (!row) return { state: 'free' }
  const events = row.events.filter((e) => active(e) && covers(e, night))
  const booked = events.find((e) => e.status === 'booked')
  if (booked) return { state: 'booked', event: booked }
  if (closedOn(row.special_prices, night)) return { state: 'closed' }
  const hold = events.find((e) => e.status === 'request')
  return hold ? { state: 'hold', event: hold } : { state: 'free' }
}

function runsOf(row: Row | undefined, nights: string[]): Run[] {
  const runs: Run[] = []
  for (const night of nights) {
    const { state, event } = nightOf(row, night)
    const last = runs.at(-1)
    if (last && last.state === state && last.booking_id === event?.id) {
      last.to = addDays(night, 1)
      continue
    }
    runs.push({
      from: night,
      to: addDays(night, 1),
      state,
      ...(event ? { booking_id: event.id, guest_name: event.client?.fio ?? null } : {}),
    })
  }
  return runs
}

function stayRulesFor(stayRules: StayRules, categoryId: number, checkIn: string, checkOut: string, nights: string[]) {
  const days = new Map((stayRules.apartments.find((a) => a.id === categoryId)?.prices ?? []).map((d) => [d.date, d]))
  const runs: StayRuleRun[] = []
  for (const night of nights) {
    const d = days.get(night)
    const rule = {
      min_stay: d?.min_stay_through.actual ?? null,
      no_arrival: d?.closed_on_arrivial.actual ?? false,
      no_departure: d?.closed_on_departure.actual ?? false,
    }
    const last = runs.at(-1)
    if (
      last &&
      last.min_stay === rule.min_stay &&
      last.no_arrival === rule.no_arrival &&
      last.no_departure === rule.no_departure
    ) {
      last.to = addDays(night, 1)
    } else runs.push({ from: night, to: addDays(night, 1), ...rule })
  }
  // ⚠ S9: min stay is applied to every night of the stay (strictest wins).
  const mins = nights.map((n) => days.get(n)?.min_stay_through.actual).filter((m): m is number => m != null)
  const minStay = mins.length ? Math.max(...mins) : null
  const problems: string[] = []
  if (minStay != null && nights.length < minStay) problems.push(`min stay ${minStay} nights`)
  if (days.get(checkIn)?.closed_on_arrivial.actual) problems.push(`no check-in on ${checkIn}`)
  if (days.get(checkOut)?.closed_on_departure.actual) problems.push(`no check-out on ${checkOut}`)
  const closed = nights.filter((n) => days.get(n)?.closed.actual)
  if (closed.length) problems.push(`closed on ${closed.join(', ')}`)
  return { min_stay: minStay, stay_ok: problems.length === 0, problems, runs }
}

export function availability(input: AvailabilityInput): CategoryAvailability[] {
  const { catalog, grid, checkIn, checkOut } = input
  const nights = nightsOf(checkIn, checkOut)
  return input.categories.map((category) => {
    const rowOf = (roomId: number | null) =>
      grid.items.find((i) => i.apartment_id === category.id && i.room_id === roomId)
    const nullRow = rowOf(null)
    const price = input.prices.get(category.id)
    const base = {
      category: category.shortTitle,
      category_id: category.id,
      single_unit: category.singleUnit,
      capacity: category.capacity,
      max_guests: category.maxGuests,
      price_total: price ?? null,
      price_per_night: price == null ? null : Math.round(price / nights.length),
      stay_rules: stayRulesFor(input.stayRules, category.id, checkIn, checkOut, nights),
    }

    if (category.singleUnit) {
      const states = nights.map((n) => nightOf(nullRow, n).state)
      const bookable = states.every((s) => s === 'free' || s === 'hold')
      return {
        ...base,
        bookable_count: bookable ? 1 : 0,
        bookable_rooms: [],
        empty_rooms: [],
        held_rooms: [],
        unit_runs: runsOf(nullRow, nights),
      }
    }

    // Per night: rooms that are neither booked nor closed, minus unassigned booked stays (holds don't count).
    const unassignedBooked = (night: string) =>
      (nullRow?.events ?? []).filter((e) => active(e) && e.status === 'booked' && covers(e, night)).length
    const spare = nights.map(
      (night) =>
        category.rooms.filter((r) => {
          const s = nightOf(rowOf(r.id), night).state
          return s === 'free' || s === 'hold'
        }).length - unassignedBooked(night),
    )
    const categoryFull = spare.some((n) => n < 1)

    const rooms = category.rooms.map((room): RoomAvailability & { empty: boolean; held: boolean } => {
      const row = rowOf(room.id)
      const states = nights.map((n) => nightOf(row, n).state)
      const reason = states.includes('booked')
        ? 'booked'
        : states.includes('closed')
          ? 'closed'
          : categoryFull
            ? 'category_full'
            : null
      return {
        room: room.title,
        room_id: room.id,
        bookable: reason === null,
        reason,
        runs: runsOf(row, nights),
        empty: !states.includes('booked'),
        held: !states.includes('booked') && states.includes('hold'),
      }
    })

    const unassigned = sortBookings(
      (nullRow?.events ?? [])
        .filter((e) => active(e) && e.begin_date < checkOut && e.end_date > checkIn)
        .map((e) => fromGridEvent(catalog, e, nullRow!)),
    )
    const shown = input.roomId == null ? rooms : rooms.filter((r) => r.room_id === input.roomId)
    return {
      ...base,
      bookable_count: Math.max(0, Math.min(...spare)),
      bookable_rooms: rooms.filter((r) => r.bookable).map((r) => r.room),
      empty_rooms: rooms.filter((r) => r.empty).map((r) => r.room),
      held_rooms: rooms.filter((r) => r.held).map((r) => r.room),
      unassigned,
      ...(input.detail === 'rooms' ? { rooms: shown.map(({ empty: _e, held: _h, ...r }) => r) } : {}),
    }
  })
}

export interface StayCheckInput {
  catalog: Catalog
  category: Category
  /** null = unassigned, or the unit of a single-unit category. */
  roomId: number | null
  status: string
  grid: Grid
  stayRules: StayRules
  checkIn: string
  checkOut: string
  /** The booking being changed: its own nights don't count against it. */
  excludeBookingId?: number
}

export interface StayCheck {
  /** RC will certainly refuse: the room has a booked night, or the category is full on some night. */
  will_fail: boolean
  /** The booked stays that fill the room or the category on the failing nights. */
  conflicts: BookingSummary[]
  /** Holds overlapping the stay in the same room (or the category, without a room); RC allows these. */
  holds: BookingSummary[]
  /** Nights the room (or single unit) is closed; RC doesn't enforce closures (S2). */
  closed_nights: string[]
  /** Broken stay rules (min stay, no check-in / check-out day, closed); RC doesn't enforce them either. */
  stay_problems: string[]
}

/**
 * The capacity check of a write preview (spec §1 Writes), by the rule RC enforces: per room one `booked`, per
 * category assigned + unassigned `booked` ≤ rooms (1 for a single unit). Holds never fail. Unlike
 * check_availability's bookable counts, closed rooms don't reduce capacity here, because RC ignores closures.
 */
export function stayCheck(input: StayCheckInput): StayCheck {
  const { catalog, category, roomId, checkIn, checkOut } = input
  const nights = nightsOf(checkIn, checkOut)
  const rows = input.grid.items.filter((i) => i.apartment_id === category.id)
  const events = rows.flatMap((row) =>
    row.events
      .filter((e) => active(e) && e.id !== input.excludeBookingId && e.begin_date < checkOut && e.end_date > checkIn)
      .map((e) => ({ row, e })),
  )
  const inRoom = (x: { row: Row }) => roomId == null || x.row.room_id === roomId

  const conflicts = new Map<number, BookingSummary>()
  if (input.status === 'booked') {
    for (const night of nights) {
      const booked = events.filter((x) => x.e.status === 'booked' && covers(x.e, night))
      const roomBusy = roomId != null && booked.filter((x) => x.row.room_id === roomId)
      const failing = roomBusy && roomBusy.length ? roomBusy : booked.length >= category.capacity ? booked : []
      for (const x of failing) conflicts.set(x.e.id, fromGridEvent(catalog, x.e, x.row))
    }
  }
  const holds = events
    .filter((x) => x.e.status === 'request' && inRoom(x))
    .map((x) => fromGridEvent(catalog, x.e, x.row))
  const unitRow = roomId != null || category.singleUnit ? rows.find((r) => r.room_id === roomId) : undefined
  return {
    will_fail: conflicts.size > 0,
    conflicts: sortBookings([...conflicts.values()]),
    holds: sortBookings(holds),
    closed_nights: unitRow ? nights.filter((n) => closedOn(unitRow.special_prices, n)) : [],
    stay_problems: stayRulesFor(input.stayRules, category.id, checkIn, checkOut, nights).problems,
  }
}
