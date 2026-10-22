import { z } from 'zod'
import { fromBooking } from '../../domain/bookings.js'
import { bookingLine, bookingSite, hasPayments, type Warning } from '../../domain/warnings.js'
import { deleteBooking as rcDelete } from '../../upstream/api.js'
import { defineWriteTool } from './define.js'
import { bookingForWrite, guardSiteBooking, today } from './shared.js'

export const deleteBookingTools = defineWriteTool({
  name: 'delete_booking',
  level: 'full',
  title: 'Delete booking',
  description:
    'Delete a booking entered by mistake or a duplicate (создал по ошибке, дубль, удали ошибочную). If the guest ' +
    'cancelled, that is preview_cancel_booking; if the user just says "сними бронь", ask which.',
  saves: 'Deletes the booking previewed by preview_delete_booking.',
  input: z.object({
    booking_id: z.number().int().positive().describe('RealtyCalendar booking id (from list_bookings)'),
  }),
  lockId: (args) => args.booking_id,

  async preview(ctx, args) {
    const { catalog, raw, paid, before, state } = await bookingForWrite(ctx, args.booking_id)
    guardSiteBooking(ctx, raw, 'delete it')
    const warnings: Warning[] = []
    if (raw.platform_name) warnings.push(bookingSite(raw.platform_name, 'deleting it here'))
    if (paid !== 0) warnings.push(hasPayments(paid, catalog.currency))
    const t = today(ctx).today
    return {
      plan: { booking_id: raw.id, state, delete: true },
      view: {
        summary: `Удалить бронь ${raw.id}: ${bookingLine(before, catalog.currency, t)}`,
        currency: catalog.currency,
        before,
        warnings,
        will_fail: false,
      },
      blocked: false,
      audit: { booking_id: raw.id, fields: ['is_delete'], before: raw },
      paid,
      catalog,
      today: t,
    }
  },

  async commit(ctx, args, p) {
    const deleted = await rcDelete(ctx.rc, args.booking_id)
    const booking = fromBooking(p.catalog, deleted, p.paid)
    return {
      summary: `Бронь ${booking.id} удалена: ${bookingLine(booking, p.catalog.currency, p.today)}`,
      currency: p.catalog.currency,
      booking,
      deleted: deleted.is_delete,
    }
  },
})
