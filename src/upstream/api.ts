// One typed function per RC endpoint. Write endpoints come with M2.
import { z } from 'zod'
import type { RcClient } from './client.js'
import {
  ApartmentInfoSchema,
  ApartmentsSchema,
  BookingSchema,
  GridSchema,
  InfoSchema,
  PaymentsSchema,
  PriceSchema,
  SignInSchema,
  StayRulesSchema,
  type Grid,
} from './schemas.js'

export type BookingStatus = 'booked' | 'request' | 'canceled'

export const getInfo = (rc: RcClient) => rc.get('info', {}, InfoSchema)

export const getApartments = (rc: RcClient) =>
  rc.get('apartments', { can_see: 'me', with_archive: 0, page: 1 }, ApartmentsSchema)

export const getApartmentInfo = (rc: RcClient, id: number) =>
  rc.get(`apartments/${id}/apartment_info`, {}, ApartmentInfoSchema)

/** Calendar grid: bookings overlapping the range plus per-room special_prices rows. Ids chunked by 10 when > 50. */
export async function getGrid(
  rc: RcClient,
  q: { begin: string; end: string; statuses: readonly BookingStatus[]; apartmentIds: readonly number[] },
): Promise<Grid> {
  const ids = q.apartmentIds
  const chunks =
    ids.length > 50
      ? Array.from({ length: Math.ceil(ids.length / 10) }, (_, i) => ids.slice(i * 10, i * 10 + 10))
      : [ids]
  const grids = await Promise.all(
    chunks.map((chunk) =>
      rc.get(
        'event_calendars/',
        { begin_date: q.begin, end_date: q.end, statuses: q.statuses, apartment_ids: chunk.join(',') },
        GridSchema,
      ),
    ),
  )
  return { items: grids.flatMap((g) => g.items) }
}

/** Per category and day in [begin, end] (both inclusive): min stay, closures. A read, despite POST. */
export const getStayRules = (rc: RcClient, q: { begin: string; end: string; apartmentIds: readonly number[] }) =>
  rc.send(
    'POST',
    'events/group_special_prices/prices',
    { apartment_ids: q.apartmentIds, begin_date: q.begin, end_date: q.end },
    StayRulesSchema,
  )

export const getPrice = (rc: RcClient, apartmentId: number, begin: string, end: string) =>
  rc.get(`apartments/${apartmentId}/price`, { begin_date: begin, end_date: end }, PriceSchema)

export const getBooking = (rc: RcClient, id: number) => rc.get(`event_calendars/${id}`, {}, BookingSchema)

export const getPayments = (rc: RcClient, id: number) => rc.get(`event_calendars/${id}/payments`, {}, PaymentsSchema)

export const signIn = (rc: RcClient, username: string, password: string) =>
  rc.send('POST', 'sign_in', { username, password }, SignInSchema)

export const signOut = (rc: RcClient) => rc.send('DELETE', 'sign_in', undefined, z.unknown())
