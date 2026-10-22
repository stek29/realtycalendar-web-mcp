import { z } from 'zod'
import { fromBooking } from '../../domain/bookings.js'
import { stayCheck } from '../../domain/calendar.js'
import { categoryById, resolveCategory, resolveRoom, roomById, type Catalog } from '../../domain/catalog.js'
import { nightsBetween } from '../../domain/dates.js'
import { ToolError } from '../../domain/errors.js'
import { bookingLine, bookingSite, money, pastDates, stayWarnings, type Warning } from '../../domain/warnings.js'
import { appendNote, applyChanges, putBodyFromGet, updatedAmount, type BookingFields } from '../../domain/writes.js'
import { getGrid, getPrice, getStayRules, putBooking } from '../../upstream/api.js'
import { defineWriteTool } from './define.js'
import {
  bookingForWrite,
  checkRange,
  guardSiteBooking,
  dateInput,
  CATEGORY_HINT,
  STAY_TOO_LONG,
  timeInput,
  today,
  withCatalog,
} from './shared.js'

const MAX_NIGHTS = 62

/** PUT field → the tool's word for it in `changes`. */
const FIELD_NAMES: Record<keyof BookingFields, string> = {
  apartment_id: 'category',
  realty_room_id: 'room',
  status: 'status',
  begin_date: 'check_in',
  end_date: 'check_out',
  arrival_time: 'arrival_time',
  departure_time: 'departure_time',
  amount: 'total',
  notes: 'notes',
}

/** Changes a booking site doesn't receive (RC's own warning covers the same fields). */
/** The same in the Russian summary line. */
const SUMMARY_NAMES: Record<keyof BookingFields, string> = {
  apartment_id: 'категория',
  realty_room_id: 'номер',
  status: 'статус',
  begin_date: 'заезд',
  end_date: 'выезд',
  arrival_time: 'время заезда',
  departure_time: 'время выезда',
  amount: 'сумма',
  notes: 'заметка',
}

const SITE_FIELDS = new Set<keyof BookingFields>([
  'apartment_id',
  'realty_room_id',
  'status',
  'begin_date',
  'end_date',
  'amount',
])
/** What a booking site sold; RC_SITE_BOOKINGS=protect keeps these (a room within the category is not sold). */
const SOLD = new Set<keyof BookingFields>(['apartment_id', 'status', 'begin_date', 'end_date', 'amount'])
const PLACEMENT = new Set<keyof BookingFields>(['apartment_id', 'realty_room_id', 'status', 'begin_date', 'end_date'])

const CHANGE_ARGS = [
  'check_in',
  'check_out',
  'room',
  'category',
  'unassign',
  'status',
  'price_per_night',
  'total',
  'arrival_time',
  'departure_time',
  'clear_arrival_time',
  'clear_departure_time',
  'notes_append',
  'notes_replace',
] as const

export const updateBookingTools = defineWriteTool({
  name: 'update_booking',
  level: 'edit',
  title: 'Update booking',
  description:
    'Change an existing booking: dates (перенести, продлить, сократить), room or category (переселить), put an ' +
    'unassigned booking in a room (расселить, "поставь бронь с Островка в 22-й") or take it out, confirm a hold ' +
    '(заявка → бронь), price, ' +
    'arrival/departure time, note. Pass only what changes. Without a new price, a different number of nights keeps ' +
    'the old price per night and a new category keeps the total; the preview then says so and asks. Not for ' +
    "cancelling (preview_cancel_booking); can't change the guest's name or contacts.",
  saves: 'Saves the change previewed by preview_update_booking.',
  noToken: 'will_fail (room or category full)',
  input: z.object({
    booking_id: z
      .number()
      .int()
      .positive()
      .describe('RealtyCalendar booking id (from list_bookings), not a room number'),
    check_in: dateInput('New arrival day, YYYY-MM-DD').optional(),
    check_out: dateInput('New departure day, YYYY-MM-DD; at most 62 nights').optional(),
    room: z.string().optional().describe('Move to / put in this room ("22"); the category follows the room'),
    category: z.string().optional().describe(`Move to another category, without a room. ${CATEGORY_HINT}`),
    unassign: z.boolean().optional().describe('true = take it out of its room, keep the category'),
    status: z.enum(['booked', 'request']).optional().describe('booked (confirm a hold) or request (make it a hold)'),
    price_per_night: z
      .number()
      .min(0)
      .optional()
      .describe("New price per night in the hotel's currency; this OR total"),
    total: z
      .number()
      .min(0)
      .optional()
      .describe("New price of the whole stay in the hotel's currency; this OR price_per_night"),
    arrival_time: timeInput('HH:MM').optional(),
    departure_time: timeInput('HH:MM').optional(),
    clear_arrival_time: z.boolean().optional().describe('true = remove the arrival time'),
    clear_departure_time: z.boolean().optional().describe('true = remove the departure time'),
    notes_append: z.string().optional().describe('Add a line to the note (default for "добавь в заметку")'),
    notes_replace: z
      .string()
      .optional()
      .describe('Replace the whole note ("" clears it); only when the user asks to rewrite it'),
  }),
  lockId: (args) => args.booking_id,

  async preview(ctx, args) {
    validate(args)
    const { catalog, raw, paid, before, state } = await bookingForWrite(ctx, args.booking_id)
    const body = putBodyFromGet(raw)
    const now = body.event_calendar

    const target = await withCatalog(ctx, (catalog) => {
      if (args.room) {
        const room = resolveRoom(catalog, args.room)
        return { apartment_id: room.categoryId, realty_room_id: room.id }
      }
      if (args.category) return { apartment_id: resolveCategory(catalog, args.category).id, realty_room_id: null }
      if (args.unassign) return { apartment_id: now.apartment_id, realty_room_id: null }
      return { apartment_id: now.apartment_id, realty_room_id: now.realty_room_id }
    })
    const begin = args.check_in ?? now.begin_date
    const end = args.check_out ?? now.end_date
    const nights = checkRange(begin, end, MAX_NIGHTS, undefined, STAY_TOO_LONG)
    const categoryChanged = target.apartment_id !== now.apartment_id
    const price = updatedAmount({
      amount: now.amount,
      oldNights: nightsBetween(now.begin_date, now.end_date),
      newNights: nights,
      categoryChanged,
      total: args.total,
      perNight: args.price_per_night,
    })
    const set: BookingFields = {
      ...target,
      status: args.status ?? now.status,
      begin_date: begin,
      end_date: end,
      arrival_time: args.clear_arrival_time ? null : (args.arrival_time ?? now.arrival_time),
      departure_time: args.clear_departure_time ? null : (args.departure_time ?? now.departure_time),
      amount: price.amount,
      notes:
        args.notes_replace != null
          ? args.notes_replace
          : args.notes_append != null
            ? appendNote(now.notes, args.notes_append)
            : now.notes,
    }
    const changed = (Object.keys(set) as (keyof BookingFields)[]).filter((k) => set[k] !== now[k])
    if (!changed.length) {
      throw new ToolError('VALIDATION', 'Nothing would change: the booking already has these values')
    }
    const sold = changed.filter((k) => SOLD.has(k))
    if (sold.length) guardSiteBooking(ctx, raw, `change its ${sold.map((k) => FIELD_NAMES[k]).join(', ')}`)

    const category = categoryById(catalog, set.apartment_id)!
    const t = today(ctx).today
    const placementChanged = changed.some((k) => PLACEMENT.has(k))
    const needQuote = price.rule === 'kept_average' || price.rule === 'kept_total'
    const [grid, stayRules, quote] = await Promise.all([
      placementChanged
        ? getGrid(ctx.rc, { begin, end, statuses: ['booked', 'request'], apartmentIds: [set.apartment_id] })
        : undefined,
      placementChanged ? getStayRules(ctx.rc, { begin, end, apartmentIds: [set.apartment_id] }) : undefined,
      needQuote ? getPrice(ctx.rc, set.apartment_id, begin, end).then((p) => p.price) : undefined,
    ])
    const check =
      grid && stayRules
        ? stayCheck({
            catalog,
            category,
            roomId: set.realty_room_id,
            status: set.status,
            grid,
            stayRules,
            checkIn: begin,
            checkOut: end,
            excludeBookingId: raw.id,
          })
        : undefined

    const warnings: Warning[] = []
    if (categoryChanged) {
      warnings.push({
        code: 'CATEGORY_CHANGE',
        message: `The booking moves from ${categoryById(catalog, now.apartment_id)?.shortTitle} to ${category.shortTitle}.`,
      })
    }
    if (price.rule === 'kept_average') {
      warnings.push({
        code: 'PRICE_CHANGED',
        message: `The total changes from ${money(now.amount, catalog.currency)} to ${money(set.amount, catalog.currency)} (the old average per night). RealtyCalendar's price for the new stay: ${money(quote!, catalog.currency)}. Ask which to use.`,
        old_total: now.amount,
        new_total: set.amount,
        quote,
      })
    }
    if (price.rule === 'kept_total') {
      warnings.push({
        code: 'PRICE_KEPT',
        message: `The total stays ${money(set.amount, catalog.currency)}. RealtyCalendar's price in the new category: ${money(quote!, catalog.currency)}. Ask which to use.`,
        total: set.amount,
        quote,
      })
    }
    if (raw.platform_name && changed.some((k) => SITE_FIELDS.has(k))) {
      warnings.push(bookingSite(raw.platform_name, 'this change'))
    }
    if (check) warnings.push(...stayWarnings(check))
    if (changed.includes('begin_date')) warnings.push(...pastDates(begin, t))

    const after = fromBooking(catalog, { ...raw, ...set }, paid)
    const changes = changed.map((k) => ({
      field: FIELD_NAMES[k],
      from: display(catalog, k, now[k]),
      to: display(catalog, k, set[k]),
    }))
    const setChanged = Object.fromEntries(changed.map((k) => [k, set[k]]))
    return {
      plan: { booking_id: raw.id, state, set: setChanged },
      view: {
        summary: `Изменить бронь ${raw.id} (${bookingLine(before, catalog.currency, t)}): ${changed
          .map((k) =>
            k === 'notes'
              ? 'заметка изменена'
              : `${SUMMARY_NAMES[k]} ${display(catalog, k, now[k]) ?? '—'} → ${display(catalog, k, set[k]) ?? '—'}`,
          )
          .join('; ')}`,
        currency: catalog.currency,
        before,
        after,
        changes,
        warnings,
        will_fail: check?.will_fail ?? false,
        conflicts: check?.conflicts ?? [],
        ...(quote != null ? { quote } : {}),
      },
      blocked: check?.will_fail ?? false,
      audit: { booking_id: raw.id, fields: changed, before: raw },
      body: applyChanges(body, set),
      paid,
      catalog,
      today: t,
    }
  },

  async commit(ctx, args, p) {
    const saved = await putBooking(ctx.rc, args.booking_id, p.body)
    const booking = fromBooking(p.catalog, saved, p.paid)
    return {
      summary: `Бронь ${booking.id} изменена: ${bookingLine(booking, p.catalog.currency, p.today)}`,
      currency: p.catalog.currency,
      booking,
    }
  },
})

type Args = { [K in (typeof CHANGE_ARGS)[number]]?: unknown }

function validate(args: Args) {
  const given = CHANGE_ARGS.filter((k) => args[k] != null && args[k] !== false)
  if (!given.length)
    throw new ToolError('VALIDATION', 'Nothing to change', `Pass at least one of: ${CHANGE_ARGS.join(', ')}`)
  const exclusive = (keys: (typeof CHANGE_ARGS)[number][]) => {
    const both = keys.filter((k) => given.includes(k))
    if (both.length > 1) throw new ToolError('VALIDATION', `Give only one of ${both.join(', ')}`)
  }
  exclusive(['room', 'category', 'unassign'])
  exclusive(['notes_append', 'notes_replace'])
  exclusive(['price_per_night', 'total'])
  exclusive(['arrival_time', 'clear_arrival_time'])
  exclusive(['departure_time', 'clear_departure_time'])
}

/** Ids shown as titles in `changes`. */
function display(catalog: Catalog, k: keyof BookingFields, v: string | number | null): string | number | null {
  if (k === 'apartment_id') return categoryById(catalog, v as number)?.shortTitle ?? v
  if (k === 'realty_room_id') return v == null ? null : (roomById(catalog, v as number)?.title ?? v)
  return v
}
