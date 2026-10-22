import { z } from 'zod'
import { fromBooking } from '../../domain/bookings.js'
import { ToolError } from '../../domain/errors.js'
import { bookingLine, bookingSite, hasPayments, type Warning } from '../../domain/warnings.js'
import { applyChanges, putBodyFromGet } from '../../domain/writes.js'
import { putBooking } from '../../upstream/api.js'
import { defineWriteTool } from './define.js'
import { bookingForWrite, today } from './shared.js'

export const cancelBookingTools = defineWriteTool({
  name: 'cancel_booking',
  level: 'edit',
  title: 'Cancel booking',
  description:
    "GUEST CANCELLED. The guest cancelled or won't come (отменить, отмена, гость отказался, не приедет, снять " +
    'бронь). Sets status "canceled": the record stays and the room is freed. Use this, not delete_booking, unless the ' +
    'user says the booking was entered by mistake.',
  input: z.object({ booking_id: z.number().int().positive().describe('Booking id, e.g. from list_bookings') }),
  lockId: (args) => args.booking_id,

  async preview(ctx, args) {
    const { catalog, raw, paid, before, state } = await bookingForWrite(ctx, args.booking_id)
    if (raw.status === 'canceled') throw new ToolError('VALIDATION', `Booking ${raw.id} is already canceled`)
    const body = applyChanges(putBodyFromGet(raw), { status: 'canceled' })
    const warnings: Warning[] = []
    if (raw.platform_name) warnings.push(bookingSite(raw.platform_name, 'the cancellation'))
    if (paid !== 0) warnings.push(hasPayments(paid, catalog.currency))
    const t = today(ctx).today
    return {
      plan: { booking_id: raw.id, state, set: { status: 'canceled' } },
      view: {
        summary: `Отменить бронь ${raw.id}: ${bookingLine(before, catalog.currency, t)}`,
        currency: catalog.currency,
        before,
        after: fromBooking(catalog, { ...raw, status: 'canceled' }, paid),
        changes: [{ field: 'status', from: raw.status, to: 'canceled' }],
        warnings,
        will_fail: false,
      },
      blocked: false,
      audit: { booking_id: raw.id, fields: ['status'], before: raw },
      body,
      paid,
      catalog,
      today: t,
    }
  },

  async commit(ctx, args, p) {
    const booking = fromBooking(p.catalog, await putBooking(ctx.rc, args.booking_id, p.body), p.paid)
    return {
      summary: `Бронь ${booking.id} отменена: ${bookingLine(booking, p.catalog.currency, p.today)}`,
      currency: p.catalog.currency,
      booking,
    }
  },
})
