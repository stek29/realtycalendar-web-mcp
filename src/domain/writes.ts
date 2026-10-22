// PUT bodies for bookings (spec §2.5 create body, §2.6 GET → PUT mapping) and the update price rules. Pure.
import { ToolError } from './errors.js'
import type { BookingRaw } from '../upstream/schemas.js'

/** The 36 keys of a live booking GET (2054-10-22). Any other key → the write is refused (fail closed). */
export const KNOWN_BOOKING_KEYS: ReadonlySet<string> = new Set([
  'additional_services',
  'amount',
  'apartment_id',
  'arrival_time',
  'attachments',
  'audits',
  'automessages_enabled',
  'begin_date',
  'booking_finished',
  'booking_started',
  'client',
  'color',
  'default_deposit_amount',
  'default_prepayment_amount',
  'departure_time',
  'deposit_refund_available_amount',
  'end_date',
  'external',
  'guest',
  'id',
  'is_delete',
  'is_external',
  'notes',
  'oki_doki_contract',
  'platform_name',
  'platform_tax',
  'prepaid_amount',
  'preparing',
  'reaction',
  'realty_room_id',
  'realty_room_title',
  'send_confirm_email',
  'send_link_prepaid',
  'source_id',
  'status',
  'updated_at',
])

export interface Person {
  id: number | null
  fio: string | null
  email: string | null
  phone: string | null
  additional_phone: string | null
}

/** The fields a write tool may set. */
export interface BookingFields {
  apartment_id: number
  realty_room_id: number | null
  status: string
  begin_date: string
  end_date: string
  arrival_time: string | null
  departure_time: string | null
  amount: number
  notes: string | null
}

export interface EventCalendar extends BookingFields {
  platform_tax: number | null
  color: string | null
  reaction: string | null
  source_id: number | null
  guest: Person & { attachments: never[]; destroy_attachments_ids: never[] }
  client: Person
  attachments: never[]
  additional_services: { early_checkin: unknown; late_checkout: unknown }
}

export interface PutBody {
  event_calendar: EventCalendar
  prepaid_amount: null
  send_confirm_email: false
  send_link_prepaid: false
  lead_id: null
  destroy_attachments_ids: never[]
}

const person = (p: Person): Person => ({
  id: p.id,
  fio: p.fio,
  email: p.email,
  phone: p.phone,
  additional_phone: p.additional_phone,
})

const envelope = (event_calendar: EventCalendar): PutBody => ({
  event_calendar,
  prepaid_amount: null,
  send_confirm_email: false,
  send_link_prepaid: false,
  // Not among the GET's keys, so there is nothing to carry over.
  lead_id: null,
  destroy_attachments_ids: [],
})

/** A PUT body that leaves the booking as the GET shows it (S3 ✅): guest and client keep their ids. */
export function putBodyFromGet(raw: BookingRaw): PutBody {
  const unknown = Object.keys(raw).filter((k) => !KNOWN_BOOKING_KEYS.has(k))
  if (unknown.length) {
    throw new ToolError(
      'RC_SCHEMA_DRIFT',
      'RealtyCalendar returned booking fields this server does not know',
      'RealtyCalendar changed; report to the admin',
      { unknown_fields: unknown },
    )
  }
  if (!raw.guest || !raw.client) {
    // Saving without ids would create new guest records; refuse rather than guess.
    throw new ToolError(
      'RC_SCHEMA_DRIFT',
      'The booking has no guest or client record',
      'RealtyCalendar changed; report to the admin',
    )
  }
  return envelope({
    apartment_id: raw.apartment_id,
    realty_room_id: raw.realty_room_id,
    status: raw.status,
    begin_date: raw.begin_date,
    end_date: raw.end_date,
    arrival_time: raw.arrival_time,
    departure_time: raw.departure_time,
    amount: raw.amount,
    platform_tax: raw.platform_tax,
    notes: raw.notes,
    color: raw.color,
    reaction: raw.reaction,
    source_id: raw.source_id,
    guest: { ...person(raw.guest), attachments: [], destroy_attachments_ids: [] },
    client: person(raw.client),
    // Existing attachments stay server-side; nothing is destroyed.
    attachments: [],
    additional_services: {
      early_checkin: raw.additional_services.early_checkin,
      late_checkout: raw.additional_services.late_checkout,
    },
  })
}

/** `body` with the given fields replaced. */
export function applyChanges(body: PutBody, set: Partial<BookingFields>): PutBody {
  return { ...body, event_calendar: { ...body.event_calendar, ...set } }
}

export interface CreateFields extends BookingFields {
  guest: { fio: string; phone: string | null; email: string | null }
  source_id: number | null
}

/** The body that saves a new booking over its draft; `id: null` makes RC create the guest and client records. */
export function createBody(f: CreateFields): PutBody {
  const guest: Person = { id: null, ...f.guest, additional_phone: null }
  return envelope({
    apartment_id: f.apartment_id,
    realty_room_id: f.realty_room_id,
    status: f.status,
    begin_date: f.begin_date,
    end_date: f.end_date,
    arrival_time: f.arrival_time,
    departure_time: f.departure_time,
    amount: f.amount,
    platform_tax: null,
    notes: f.notes,
    color: null,
    reaction: null,
    source_id: f.source_id,
    guest: { ...guest, attachments: [], destroy_attachments_ids: [] },
    client: guest,
    attachments: [],
    additional_services: { early_checkin: null, late_checkout: null },
  })
}

export type PriceRule = 'total' | 'per_night' | 'kept_average' | 'kept_total' | 'unchanged'

/**
 * The new amount of an updated booking (spec §2.6 price rules): a given price wins; changed nights keep the old
 * average per night; a category change on the same nights keeps the total.
 */
export function updatedAmount(o: {
  amount: number
  oldNights: number
  newNights: number
  categoryChanged: boolean
  total?: number
  perNight?: number
}): { amount: number; rule: PriceRule } {
  if (o.total != null) return { amount: o.total, rule: 'total' }
  if (o.perNight != null) return { amount: o.perNight * o.newNights, rule: 'per_night' }
  if (o.newNights !== o.oldNights)
    return { amount: Math.round((o.amount / o.oldNights) * o.newNights), rule: 'kept_average' }
  return { amount: o.amount, rule: o.categoryChanged ? 'kept_total' : 'unchanged' }
}

/** "Add to the note": the old text, a line break, the new line. */
export const appendNote = (old: string | null, line: string): string => (old ? `${old}\n${line}` : line)
