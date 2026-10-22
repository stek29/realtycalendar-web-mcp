// Booking summaries from the grid and the booking detail (spec §1 Output, §2.3, §2.4). Pure: no IO.
import { categoryById, isBookingSite, roomById, sourceTitle, type Catalog } from './catalog.js'
import { nightsBetween } from './dates.js'
import { nameMatches, translit, words } from './match.js'
import type { Booking, Grid, GridEvent, Payments } from '../upstream/schemas.js'

export interface BookingSummary {
  id: number
  status: string
  category: string
  category_id: number
  room: string | null
  room_id: number | null
  unassigned: boolean
  check_in: string
  check_out: string
  nights: number
  guest_name: string | null
  guest_phone: string | null
  source: string | null
  from_booking_site: boolean
  arrival_time: string | null
  total: number
  paid: number
  left: number
  paid_in_full: boolean
  untrusted?: { notes: string }
}

const rub = (n: number) => Math.round(n)

function summary(
  catalog: Catalog,
  b: {
    id: number
    status: string
    apartmentId: number
    roomId: number | null
    begin: string
    end: string
    fio: string | null | undefined
    phone: string | null | undefined
    sourceId: number | null
    fromBookingSite: boolean
    arrivalTime: string | null
    amount: number
    paid: number
    notes: string | null | undefined
  },
): BookingSummary {
  const category = categoryById(catalog, b.apartmentId)
  const room = b.roomId == null ? undefined : roomById(catalog, b.roomId)
  const total = rub(b.amount)
  const paid = rub(b.paid)
  return {
    id: b.id,
    status: b.status,
    category: category?.shortTitle ?? String(b.apartmentId),
    category_id: b.apartmentId,
    room: room?.title ?? null,
    room_id: room?.id ?? null,
    unassigned: room == null && category != null && !category.singleUnit,
    check_in: b.begin,
    check_out: b.end,
    nights: nightsBetween(b.begin, b.end),
    guest_name: b.fio || null,
    guest_phone: b.phone || null,
    source: sourceTitle(catalog, b.sourceId),
    from_booking_site: b.fromBookingSite,
    arrival_time: b.arrivalTime,
    total,
    paid,
    left: total - paid,
    paid_in_full: paid >= total,
    ...(b.notes ? { untrusted: { notes: b.notes } } : {}),
  }
}

/** A grid booking; the room comes from the grid row (null row = unassigned or single-unit). */
export function fromGridEvent(catalog: Catalog, e: GridEvent, row: { apartment_id: number; room_id: number | null }) {
  return summary(catalog, {
    id: e.id,
    status: e.status,
    apartmentId: row.apartment_id,
    roomId: row.room_id,
    begin: e.begin_date,
    end: e.end_date,
    fio: e.client?.fio,
    phone: e.client?.phone,
    sourceId: e.source_id,
    // S1: Yandex Travel / T-Travel bookings have is_external false but a booking-site source.
    fromBookingSite: e.is_external || isBookingSite(catalog, e.source_id),
    arrivalTime: e.arrival_time,
    amount: e.amount,
    paid: e.prepayment,
    notes: e.short_notes,
  })
}

/** All bookings in the grid, deleted ones dropped. */
export function fromGrid(catalog: Catalog, grid: Grid): BookingSummary[] {
  return grid.items.flatMap((row) => row.events.filter((e) => !e.is_delete).map((e) => fromGridEvent(catalog, e, row)))
}

export interface BookingFilter {
  categoryIds?: ReadonlySet<number>
  roomId?: number
  sourceTitles?: ReadonlySet<string>
  query?: string
  statuses?: ReadonlySet<string>
  unassignedOnly?: boolean
  unpaidOnly?: boolean
}

/** Phone digits (≥ 5) match anywhere in the phone; otherwise every query word must match the guest name. */
export function matchesQuery(b: BookingSummary, query: string): boolean {
  if (isPhoneQuery(query)) {
    let digits = query.replace(/\D/g, '')
    // A full Russian number may start with 8 or 7 (+7): compare the last 10 digits.
    if (digits.length === 11 && /^[78]/.test(digits)) digits = digits.slice(1)
    return (b.guest_phone ?? '').replace(/\D/g, '').includes(digits)
  }
  if (b.guest_name == null) return false
  // Guests from booking sites are often stored in Latin: compare in both scripts ("Игорь" ~ "Igor").
  const q = words(query)
  const t = words(b.guest_name)
  return nameMatches(q, t) || nameMatches(q.map(translit), t.map(translit))
}

/** At least 5 digits and no letters: a phone search. */
export function isPhoneQuery(query: string): boolean {
  return query.replace(/\D/g, '').length >= 5 && !/\p{L}/u.test(query)
}

export function filterBookings(list: BookingSummary[], f: BookingFilter): BookingSummary[] {
  return list.filter(
    (b) =>
      (!f.statuses || f.statuses.has(b.status)) &&
      (!f.categoryIds || f.categoryIds.has(b.category_id)) &&
      (f.roomId == null || b.room_id === f.roomId) &&
      (!f.sourceTitles || (b.source != null && f.sourceTitles.has(b.source))) &&
      (!f.query || matchesQuery(b, f.query)) &&
      (!f.unassignedOnly || b.unassigned) &&
      (!f.unpaidOnly || b.left > 0),
  )
}

/** By `by` date, then category, then room (numeric). */
export function sortBookings(list: BookingSummary[], by: 'check_in' | 'check_out' = 'check_in'): BookingSummary[] {
  const roomKey = (b: BookingSummary) => b.room ?? ''
  return [...list].sort(
    (a, b) =>
      a[by].localeCompare(b[by]) ||
      a.category.localeCompare(b.category, 'ru', { numeric: true }) ||
      roomKey(a).localeCompare(roomKey(b), 'ru', { numeric: true }) ||
      a.id - b.id,
  )
}

export function totals(list: BookingSummary[]) {
  return {
    bookings: list.length,
    nights: list.reduce((s, b) => s + b.nights, 0),
    total: list.reduce((s, b) => s + b.total, 0),
    paid: list.reduce((s, b) => s + b.paid, 0),
    left: list.reduce((s, b) => s + b.left, 0),
  }
}

/** "2054-10-01 09:00:00 MSK" (audit format) → "2054-10-01T09:00:00+03:00". */
export function auditTime(s: string): string {
  const m = s.match(/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) MSK$/)
  return m ? `${m[1]}T${m[2]}+03:00` : s
}

/** Detail fields like "2054-10-21T20:38:35.123+03:00" → without milliseconds. */
const isoSeconds = (s: string) => s.replace(/\.\d+(?=[+-Z])/, '')

/** A booking from its detail (or a PUT / DELETE response, same shape) with `paid` from its payments. */
export function fromBooking(
  catalog: Catalog,
  b: Booking,
  paid: number,
): BookingSummary & { departure_time: string | null } {
  const guest = b.client ?? b.guest
  return {
    ...summary(catalog, {
      id: b.id,
      status: b.status,
      apartmentId: b.apartment_id,
      roomId: b.realty_room_id,
      begin: b.begin_date,
      end: b.end_date,
      fio: guest?.fio ?? b.guest?.fio,
      phone: guest?.phone ?? b.guest?.phone,
      sourceId: b.source_id,
      fromBookingSite: b.platform_name != null,
      arrivalTime: b.arrival_time,
      amount: b.amount,
      paid,
      notes: b.notes,
    }),
    departure_time: b.departure_time,
  }
}

export const paidOf = (payments: Payments) => payments.data.reduce((s, p) => s + p.payment.amount, 0)

export function fromDetail(catalog: Catalog, b: Booking, payments: Payments) {
  const guest = b.client ?? b.guest
  const fields = b.external?.fields ?? []
  const first = [...b.audits].sort((x, y) => x.version - y.version)[0]
  return {
    ...fromBooking(catalog, b, paidOf(payments)),
    guest_email: guest?.email ?? b.guest?.email ?? null,
    booking_site: b.platform_name
      ? {
          platform: b.platform_name,
          untrusted: {
            fields: Object.fromEntries(
              fields.filter((f) => f.value != null && f.value !== '').map((f) => [f.title, String(f.value)]),
            ),
          },
        }
      : null,
    payments: payments.data.map((p) => ({
      id: p.id,
      date: p.created_at.slice(0, 10),
      amount: rub(p.payment.amount),
      type: p.payment.type,
      account: p.invoice?.title ?? null,
      note: p.note,
      status: p.status.text,
    })),
    created_at: first ? auditTime(first.created_at) : null,
    updated_at: isoSeconds(b.updated_at),
    deleted: b.is_delete,
  }
}
