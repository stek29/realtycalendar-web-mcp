import { z } from 'zod'
import { filterBookings, fromGrid, sortBookings, totals } from '../../domain/bookings.js'
import { resolveCategories, resolveRoom, resolveSources } from '../../domain/catalog.js'
import { addDays, todayIn } from '../../domain/dates.js'
import { getGrid } from '../../upstream/api.js'
import { defineTool, READ_ANNOTATIONS } from './define.js'
import { BookingSummaryShape, checkRange, dateInput, NAME_HINT, today, withCatalog } from './shared.js'

const MAX_DAYS = 180

export const listBookings = defineTool({
  name: 'list_bookings',
  level: 'read',
  title: 'List bookings',
  description:
    'BOOKING VIEW. Bookings in a period, by how they relate to it: `staying` (кто живёт, в каком номере Иванов), ' +
    '`arriving` (заезды, кто заезжает завтра) or `departing` (выезды, кто выезжает сегодня, что убирать). Filters: room ' +
    'or category, source/channel (Островок, Яндекс Путешествия…), guest name or phone, holds only, unassigned only ' +
    '(неразобранные), not paid in full (кто не доплатил, кто должен). Returns totals (sum, paid, left) over all matches. ' +
    'For searches ("найди бронь Петровой", "бронь с Островка") pass a wide period, e.g. to = today + 180 days. ' +
    'Not for "is room X free" (use check_availability). Bookings can\'t be found by the date they were made.',
  input: z.object({
    from: dateInput('Start of the period, YYYY-MM-DD; default today').optional(),
    to: dateInput('End of the period (exclusive); default from + 1 day; at most 180 days after from').optional(),
    match: z
      .enum(['staying', 'arriving', 'departing'])
      .optional()
      .describe(
        'staying: the stay overlaps [from, to) (default); arriving: check_in in [from, to); departing: check_out in [from, to)',
      ),
    category: z
      .string()
      .optional()
      .describe(`Category: id, number ("02") or title words; all matches are used. ${NAME_HINT}`),
    room: z.string().optional().describe('Room title like "22" or its id'),
    source: z
      .string()
      .optional()
      .describe('Channel name in Latin or Cyrillic: "островок", "ostrovok", "яндекс"; all matches'),
    query: z.string().optional().describe(`Guest name words or phone digits (at least 5, any format). ${NAME_HINT}`),
    status: z
      .array(z.enum(['booked', 'request', 'canceled']))
      .min(1)
      .optional()
      .describe('Default ["booked", "request"]; request = hold (заявка). Use ["request"] for holds only'),
    unassigned_only: z.boolean().optional().describe('Only bookings without a room in categories that have rooms'),
    unpaid_only: z.boolean().optional().describe('Only bookings with left > 0'),
    limit: z.number().int().min(1).max(200).optional().describe('Max bookings returned (default 50); totals cover all'),
  }),
  output: z.object({
    today: z.string(),
    today_weekday: z.string(),
    from: z.string(),
    to: z.string(),
    match: z.string(),
    currency: z.string(),
    matched: z.number(),
    returned: z.number(),
    totals: z.object({
      bookings: z.number(),
      nights: z.number(),
      total: z.number(),
      paid: z.number(),
      left: z.number(),
    }),
    bookings: z.array(BookingSummaryShape),
  }),
  annotations: READ_ANNOTATIONS,
  async handler(ctx, args) {
    const from = args.from ?? todayIn(ctx.now(), ctx.config.timezone)
    const to = args.to ?? addDays(from, 1)
    checkRange(from, to, MAX_DAYS, ['from', 'to'])
    const match = args.match ?? 'staying'
    const statuses = args.status ?? ['booked', 'request']

    const { catalog, categoryIds, roomId, sourceTitles } = await withCatalog(ctx, (catalog) => ({
      catalog,
      categoryIds: args.category ? new Set(resolveCategories(catalog, args.category).map((c) => c.id)) : undefined,
      roomId: args.room ? resolveRoom(catalog, args.room).id : undefined,
      sourceTitles: args.source ? new Set(resolveSources(catalog, args.source).map((s) => s.title)) : undefined,
    }))

    // A departure in [from, to) belongs to a stay overlapping the night before `from`.
    const grid = await getGrid(ctx.rc, {
      begin: match === 'departing' ? addDays(from, -1) : from,
      end: to,
      statuses,
      apartmentIds: categoryIds ? [...categoryIds] : catalog.categories.map((c) => c.id),
    })
    const inPeriod = {
      staying: (b: { check_in: string; check_out: string }) => b.check_in < to && b.check_out > from,
      arriving: (b: { check_in: string }) => b.check_in >= from && b.check_in < to,
      departing: (b: { check_out: string }) => b.check_out >= from && b.check_out < to,
    }[match]
    const matched = sortBookings(
      filterBookings(fromGrid(catalog, grid), {
        statuses: new Set(statuses),
        categoryIds,
        roomId,
        sourceTitles,
        query: args.query,
        unassignedOnly: args.unassigned_only,
        unpaidOnly: args.unpaid_only,
      }).filter(inPeriod),
      match === 'departing' ? 'check_out' : 'check_in',
    )
    const bookings = matched.slice(0, args.limit ?? 50)
    return {
      ...today(ctx),
      from,
      to,
      match,
      currency: catalog.currency,
      matched: matched.length,
      returned: bookings.length,
      totals: totals(matched),
      bookings,
    }
  },
})
