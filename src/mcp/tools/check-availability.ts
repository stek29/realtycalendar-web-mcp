import { z } from 'zod'
import { availability } from '../../domain/calendar.js'
import { resolveCategories, resolveRoom, type Category } from '../../domain/catalog.js'
import { weekday } from '../../domain/dates.js'
import { ToolError } from '../../domain/errors.js'
import { getGrid, getPrice, getStayRules } from '../../upstream/api.js'
import { defineTool, READ_ANNOTATIONS } from './define.js'
import { BookingSummaryShape, CATEGORY_HINT, checkRange, DATES_HINT, dateInput, today, withCatalog } from './shared.js'

const MAX_NIGHTS = 62

const RunShape = z.object({
  from: z.string(),
  to: z.string().describe('exclusive, like check_out'),
  state: z.enum(['free', 'booked', 'hold', 'closed']),
  booking_id: z.number().optional(),
  guest_name: z.string().nullable().optional(),
})

export const checkAvailability = defineTool({
  name: 'check_availability',
  level: 'read',
  title: 'Check availability',
  description:
    "In the user's hotel: what is free, busy, on hold or closed for given dates, with the price of the stay per category (что свободно, " +
    'свободен ли 22-й, есть ли места, загрузка, сколько стоит, на троих), and the booking rules for the dates: minimum ' +
    'stay (минимальный срок), no check-in / no check-out days. A room is bookable only if it is empty AND its ' +
    'category has capacity every night (unassigned bookings use capacity without a room): answer from bookable_rooms ' +
    'and stay_rules, not empty_rooms. Mention holds (заявки) on free rooms. Not for finding a booking: use list_bookings. ' +
    DATES_HINT,
  input: z.object({
    check_in: dateInput('Arrival day, YYYY-MM-DD (hotel-local)'),
    check_out: dateInput(
      'Departure day, YYYY-MM-DD; after check_in, at most 62 nights. One night on X: X+1; for the rules of a day, too',
    ),
    category: z
      .string()
      .optional()
      .describe(
        `Category (тип номера): id, number ("02") or title words; all matching categories are used. ${CATEGORY_HINT}`,
      ),
    room: z.string().optional().describe('Room (номер) title like "22" or "22-й", or its id; implies its category'),
    guests: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe("Only categories that take at least this many guests; doesn't change the price"),
    detail: z
      .enum(['summary', 'rooms'])
      .optional()
      .describe(
        'summary = per category; rooms = also each room night by night with guests (что занято, кто где). Default: rooms when room or category is given',
      ),
  }),
  output: z.object({
    today: z.string(),
    today_weekday: z.string(),
    check_in: z.string(),
    check_in_weekday: z.string(),
    check_out: z.string(),
    check_out_weekday: z.string(),
    nights: z.number(),
    currency: z.string(),
    matched_categories: z.array(z.string()).optional(),
    categories: z.array(
      z.object({
        category: z.string(),
        category_id: z.number(),
        single_unit: z.boolean(),
        capacity: z.number(),
        max_guests: z.number(),
        bookable_count: z
          .number()
          .describe(
            'How many more bookings the category takes on its fullest night; one room free throughout: bookable_rooms',
          ),
        bookable_rooms: z
          .array(z.string())
          .describe('Free, not closed, and the category has capacity every night. Stay rules are separate'),
        empty_rooms: z.array(z.string()).describe('No booked night (may still be not bookable!)'),
        held_rooms: z.array(z.string()).describe('Empty but with a hold'),
        price_total: z.number().nullable().describe('RealtyCalendar quote for the stay'),
        price_per_night: z.number().nullable().describe('price_total / nights'),
        stay_rules: z.object({
          min_stay: z.number().nullable().describe('Strictest min stay over the nights of the stay'),
          stay_ok: z.boolean().describe('Nights ≥ min stay, arrival/departure days allowed, nothing closed'),
          problems: z.array(z.string()),
          runs: z.array(
            z.object({
              from: z.string(),
              to: z.string(),
              min_stay: z.number().nullable(),
              no_arrival: z.boolean(),
              no_departure: z.boolean(),
            }),
          ),
        }),
        unassigned: z.array(BookingSummaryShape).optional().describe('Bookings without a room in this category'),
        rooms: z
          .array(
            z.object({
              room: z.string(),
              room_id: z.number(),
              bookable: z.boolean(),
              reason: z.enum(['booked', 'closed', 'category_full']).nullable(),
              runs: z.array(RunShape),
            }),
          )
          .optional(),
        unit_runs: z.array(RunShape).optional().describe('Single-unit categories: the unit itself'),
      }),
    ),
  }),
  annotations: READ_ANNOTATIONS,
  async handler(ctx, args) {
    const nights = checkRange(args.check_in, args.check_out, MAX_NIGHTS)
    const { catalog, categories, roomId } = await withCatalog(ctx, (catalog) => {
      let categories: Category[] = args.category ? resolveCategories(catalog, args.category) : catalog.categories
      let roomId: number | undefined
      if (args.room) {
        const room = resolveRoom(catalog, args.room)
        if (args.category && !categories.some((c) => c.id === room.categoryId)) {
          throw new ToolError('ROOM_NOT_IN_CATEGORY', `Room ${room.title} is not in "${args.category}"`, undefined, {
            room_category: catalog.categories.find((c) => c.id === room.categoryId)?.shortTitle,
          })
        }
        categories = categories.filter((c) => c.id === room.categoryId)
        roomId = room.id
      }
      if (args.guests) categories = categories.filter((c) => c.maxGuests >= args.guests!)
      return { catalog, categories, roomId }
    })

    const ids = categories.map((c) => c.id)
    const [grid, stayRules, prices] = ids.length
      ? await Promise.all([
          getGrid(ctx.rc, {
            begin: args.check_in,
            end: args.check_out,
            statuses: ['booked', 'request'],
            apartmentIds: ids,
          }),
          getStayRules(ctx.rc, { begin: args.check_in, end: args.check_out, apartmentIds: ids }),
          Promise.all(
            ids.map(async (id) => [id, (await getPrice(ctx.rc, id, args.check_in, args.check_out)).price] as const),
          ),
        ])
      : [{ items: [] }, { apartments: [] }, []]

    const detail = args.detail ?? (args.room || args.category ? 'rooms' : 'summary')
    return {
      ...today(ctx),
      check_in: args.check_in,
      check_in_weekday: weekday(args.check_in),
      check_out: args.check_out,
      check_out_weekday: weekday(args.check_out),
      nights,
      currency: catalog.currency,
      ...(args.category ? { matched_categories: categories.map((c) => c.shortTitle) } : {}),
      categories: availability({
        catalog,
        categories,
        grid,
        stayRules,
        prices: new Map(prices),
        checkIn: args.check_in,
        checkOut: args.check_out,
        detail,
        roomId,
      }),
    }
  },
})
