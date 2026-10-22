import { z } from 'zod'
import { filterBookings, fromGrid, isPhoneQuery, sortBookings, totals } from '../../domain/bookings.js'
import { resolveCategories, resolveRoom, resolveSources } from '../../domain/catalog.js'
import { addDays, todayIn } from '../../domain/dates.js'
import { getGrid } from '../../upstream/api.js'
import { defineTool, READ_ANNOTATIONS } from './define.js'
import { BookingSummaryShape, CATEGORY_HINT, checkRange, DATES_HINT, dateInput, today, withCatalog } from './shared.js'

const MAX_DAYS = 180

export const listBookings = defineTool({
  name: 'list_bookings',
  level: 'read',
  title: 'List bookings',
  description:
    "Find the hotel's bookings in a period: match=staying (кто живёт, в каком номере Иванов), arriving (заезды, кто заезжает " +
    'завтра) or departing (выезды, что убирать). Filters: room, category, source (Островок, Яндекс…), guest name or ' +
    'phone, holds, unassigned (неразобранные, не расселены), unpaid (кто не доплатил, кто должен). Totals (sum, paid, ' +
    "left) cover all matches and their whole stays: a stay crossing the period's edge counts in full; say so with " +
    "the totals. The period defaults to today; to find a guest's booking with no dates given " +
    '("найди бронь Петровой") use today to today + 180 days, and say which period you searched. No filter by the ' +
    'date a booking was made: for a recent booking from a site, filter by source and read "Дата бронирования" in ' +
    'get_booking. Not for "is room X free": use check_availability. ' +
    DATES_HINT,
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
      .describe(`Category: id, number ("02") or title words; all matches are used. ${CATEGORY_HINT}`),
    room: z.string().optional().describe('Room title like "22" or its id'),
    source: z
      .string()
      .optional()
      .describe('Channel name in Latin or Cyrillic: "островок", "ostrovok", "яндекс"; all matches'),
    query: z
      .string()
      .optional()
      .describe(
        'Guest name words, Cyrillic or Latin (matched in both scripts), or phone digits (at least 5, any format). ' +
          'Use a stem if unsure: "Петров" also finds Петрова',
      ),
    status: z
      .array(z.enum(['booked', 'request', 'canceled']))
      .min(1)
      .optional()
      .describe(
        'Default ["booked", "request"]; request = hold (заявка). ["request"] = holds only; add "canceled" for отменённые',
      ),
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
      nights: z.number().describe('Whole stays, also nights outside the period'),
      total: z.number(),
      paid: z.number(),
      left: z.number(),
    }),
    bookings: z.array(BookingSummaryShape),
    hint: z.string().optional().describe('Present when a guest query found nothing'),
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
      ...(args.query && matched.length === 0 ? { hint: noMatchHint(args.query) } : {}),
    }
  },
})

/** A guest query found nothing: names may be spelled differently and phones are often missing. */
function noMatchHint(query: string): string {
  return isPhoneQuery(query)
    ? 'No booking in this period has this phone. Many bookings have no phone stored: ask the user for the guest name, or call again ' +
        'without query and look through the returned bookings.'
    : 'No guest name matched in this period. Names may be stored in another spelling, as a nickname or full name (Саша = Александр), ' +
        'or in Latin with a different transliteration (Алексей = Alexey). Call again without query for the same period ' +
        '(raise limit if needed) and look through guest_name yourself before saying the booking does not exist.'
}
