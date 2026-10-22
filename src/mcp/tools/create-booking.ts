import { z } from 'zod'
import { fromBooking, fromGridEvent, type BookingSummary } from '../../domain/bookings.js'
import { stayCheck } from '../../domain/calendar.js'
import {
  categoryById,
  resolveCategories,
  resolveCategory,
  resolveRoom,
  resolveSource,
  roomById,
} from '../../domain/catalog.js'
import { ToolError } from '../../domain/errors.js'
import { words } from '../../domain/match.js'
import { bookingBrief, bookingLine, pastDates, stayWarnings, type Warning } from '../../domain/warnings.js'
import { createBody, type CreateFields } from '../../domain/writes.js'
import { createDraft, getGrid, getPrice, getStayRules, putBooking } from '../../upstream/api.js'
import { defineWriteTool, WRITE_ANNOTATIONS } from './define.js'
import { checkRange, dateInput, NAME_HINT, timeInput, today, withCatalog } from './shared.js'

const MAX_NIGHTS = 62

const sameName = (a: string | null | undefined, b: string) => a != null && words(a).join(' ') === words(b).join(' ')

export const createBooking = defineWriteTool({
  name: 'create_booking',
  level: 'book',
  title: 'Create booking',
  description:
    'WRITE: NEW BOOKING. Create a booking or a hold (забронировать, поставить бронь; заявка = hold) in a room, or in ' +
    "a category without choosing a room when the user doesn't care which (it stays unassigned), or in a single-unit " +
    'category (коттедж). Give either room or category. Optional: price per night OR total (otherwise ' +
    "RealtyCalendar's quote), phone, e-mail, arrival/departure time, source, note. If the user gave no guest name, " +
    'ask for it. Call without confirm_token for a preview; repeat with the token only after the user agrees. Does not ' +
    'record prepayments in v1: if the user mentions one, say it must be added in RealtyCalendar ("Добавить платеж"). ' +
    'Never messages the guest.',
  input: z.object({
    room: z.string().optional().describe('Room (номер) title like "22" or "22-й", or its id. Give room or category'),
    category: z
      .string()
      .optional()
      .describe(
        `Category (тип номера) when no particular room: id, number ("02") or title words; must match one category. ${NAME_HINT}`,
      ),
    check_in: dateInput('Arrival day, YYYY-MM-DD'),
    check_out: dateInput('Departure day, YYYY-MM-DD; after check_in, at most 62 nights'),
    guest_name: z.string().describe('Guest name as the user said it; required, ask if missing'),
    guest_phone: z.string().optional(),
    guest_email: z.string().optional(),
    status: z.enum(['booked', 'request']).optional().describe('booked (бронь, default) or request (заявка, a hold)'),
    price_per_night: z.number().min(0).optional().describe('Price per night; give this OR total, not both'),
    total: z.number().min(0).optional().describe('Total for the stay; give this OR price_per_night, not both'),
    arrival_time: timeInput('HH:MM').optional(),
    departure_time: timeInput('HH:MM').optional(),
    source: z.string().optional().describe('Source / channel name, e.g. "Островок"; must match one source'),
    notes: z.string().optional(),
  }),
  annotations: WRITE_ANNOTATIONS.create,

  async preview(ctx, args) {
    if (!args.room && !args.category) {
      throw new ToolError('VALIDATION', 'Give room or category', 'Ask the user for the room or the category')
    }
    const guestName = args.guest_name.trim()
    if (!guestName) throw new ToolError('VALIDATION', 'guest_name is empty', 'Ask the user for the guest name')
    if (args.price_per_night != null && args.total != null) {
      throw new ToolError('VALIDATION', 'Give price_per_night or total, not both')
    }
    const nights = checkRange(args.check_in, args.check_out, MAX_NIGHTS)

    const { catalog, category, roomId, sourceId } = await withCatalog(ctx, (catalog) => {
      let category
      let roomId: number | null = null
      if (args.room) {
        const room = resolveRoom(catalog, args.room)
        if (args.category && !resolveCategories(catalog, args.category).some((c) => c.id === room.categoryId)) {
          throw new ToolError('ROOM_NOT_IN_CATEGORY', `Room ${room.title} is not in "${args.category}"`, undefined, {
            room_category: categoryById(catalog, room.categoryId)?.shortTitle,
          })
        }
        category = categoryById(catalog, room.categoryId)!
        roomId = room.id
      } else category = resolveCategory(catalog, args.category!)
      const sourceId = args.source ? resolveSource(catalog, args.source).id : null
      return { catalog, category, roomId, sourceId }
    })

    const status = args.status ?? 'booked'
    const [grid, stayRules, { price: quote }] = await Promise.all([
      getGrid(ctx.rc, {
        begin: args.check_in,
        end: args.check_out,
        statuses: ['booked', 'request'],
        apartmentIds: [category.id],
      }),
      getStayRules(ctx.rc, { begin: args.check_in, end: args.check_out, apartmentIds: [category.id] }),
      getPrice(ctx.rc, category.id, args.check_in, args.check_out),
    ])
    const [amount, priceSource] =
      args.total != null
        ? [args.total, 'total' as const]
        : args.price_per_night != null
          ? [args.price_per_night * nights, 'per_night' as const]
          : [quote, 'quote' as const]

    const fields: CreateFields = {
      apartment_id: category.id,
      realty_room_id: roomId,
      status,
      begin_date: args.check_in,
      end_date: args.check_out,
      arrival_time: args.arrival_time ?? null,
      departure_time: args.departure_time ?? null,
      amount,
      notes: args.notes?.trim() || null,
      source_id: sourceId,
      guest: { fio: guestName, phone: args.guest_phone?.trim() || null, email: args.guest_email?.trim() || null },
    }

    // Same room (or both without a room), same dates, same guest name: this create already happened.
    const row = grid.items.find((i) => i.apartment_id === category.id && i.room_id === roomId)
    const dup = row?.events.find(
      (e) =>
        !e.is_delete &&
        (e.status === 'booked' || e.status === 'request') &&
        e.begin_date === args.check_in &&
        e.end_date === args.check_out &&
        sameName(e.client?.fio, guestName),
    )
    const duplicate: BookingSummary | undefined = dup && row ? fromGridEvent(catalog, dup, row) : undefined

    const check = stayCheck({
      catalog,
      category,
      roomId,
      status,
      grid,
      stayRules,
      checkIn: args.check_in,
      checkOut: args.check_out,
    })
    const t = today(ctx).today
    const warnings: Warning[] = [
      ...(duplicate
        ? [
            {
              code: 'DUPLICATE' as const,
              message: `This booking already exists (id ${duplicate.id}); nothing to create.`,
              booking: bookingBrief(duplicate),
            },
          ]
        : []),
      ...stayWarnings(check),
      ...pastDates(args.check_in, t),
      {
        code: 'NO_GUEST_MESSAGES',
        message: 'No confirmation e-mail or payment link is sent to the guest.',
      },
    ]
    const room = roomId == null ? undefined : roomById(catalog, roomId)
    const after = {
      id: null,
      status,
      category: category.shortTitle,
      category_id: category.id,
      room: room?.title ?? null,
      room_id: roomId,
      unassigned: roomId == null && !category.singleUnit,
      check_in: args.check_in,
      check_out: args.check_out,
      nights,
      guest_name: guestName,
      guest_phone: fields.guest.phone,
      source: sourceId == null ? null : (catalog.sources.find((s) => s.id === sourceId)?.title ?? null),
      from_booking_site: false,
      arrival_time: fields.arrival_time,
      departure_time: fields.departure_time,
      total: amount,
      paid: 0,
      left: amount,
      paid_in_full: amount <= 0,
      ...(fields.notes ? { untrusted: { notes: fields.notes } } : {}),
    }
    const kind = status === 'request' ? 'Заявка' : 'Бронь'
    return {
      plan: { set: fields },
      view: {
        summary: `${kind}: ${bookingLine(after, catalog.currency, t)}`,
        currency: catalog.currency,
        before: null,
        after,
        warnings,
        will_fail: check.will_fail,
        conflicts: check.conflicts,
        price_source: priceSource,
        quote,
      },
      blocked: duplicate != null || check.will_fail,
      fields,
      duplicate,
      catalog,
      today: t,
    }
  },

  async commit(ctx, _args, p) {
    const { catalog, fields } = p
    if (p.duplicate) {
      // A repeated confirm (e.g. after a timeout): the booking was saved the first time.
      return {
        summary: `Бронь уже есть (${p.duplicate.id}): ${bookingLine(p.duplicate, catalog.currency, p.today)}`,
        currency: catalog.currency,
        booking: p.duplicate,
        note: 'This booking already existed; nothing new was created.',
      }
    }
    let id: number
    try {
      ;({ id } = await createDraft(ctx.rc, {
        status: fields.status,
        apartment_id: fields.apartment_id,
        realty_room_id: fields.realty_room_id,
        begin_date: fields.begin_date,
        end_date: fields.end_date,
      }))
    } catch (e) {
      throw nothingSaved(e)
    }
    let saved
    try {
      saved = await putBooking(ctx.rc, id, createBody(fields))
    } catch (e) {
      if (e instanceof ToolError && e.code === 'RC_ERROR') {
        throw new ToolError(
          'RC_ERROR',
          'Not sure the booking was saved: RealtyCalendar did not answer properly.',
          'Call again with the same confirm_token: if it was saved, the duplicate check returns it instead of creating it twice.',
        )
      }
      throw nothingSaved(e)
    }
    const booking = fromBooking(catalog, saved, 0)
    return {
      summary: `Создана ${fields.status === 'request' ? 'заявка' : 'бронь'} ${booking.id}: ${bookingLine(booking, catalog.currency, p.today)}`,
      currency: catalog.currency,
      booking,
    }
  },
})

function nothingSaved(e: unknown): unknown {
  if (!(e instanceof ToolError) || e.code === 'RC_SCHEMA_DRIFT') return e
  return new ToolError(e.code, `${e.message}. Nothing was saved.`, e.hint, e.details)
}
