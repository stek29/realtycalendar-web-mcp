// Zod schemas of RC responses: only the fields we rely on (unknown keys are stripped). Shapes recorded 2054-10-22.
import { z } from 'zod'

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
const text = z.string().nullable()
const flag = z.boolean().nullable()

export const InfoSchema = z.object({
  id: z.number(),
  full_name: text,
  role: text,
  agency: z.object({
    id: z.number(),
    title: z.string(),
    currency: z.string(),
    sources_list: z.array(z.object({ id: z.number(), title: z.string() })),
  }),
})
export type Info = z.infer<typeof InfoSchema>

export const ApartmentsSchema = z.object({
  apartments: z.array(
    z.object({
      id: z.number(),
      title: z.string(),
      archive: z.boolean(),
      rooms: z.array(z.object({ id: z.number(), title: z.string() })),
    }),
  ),
})
export type Apartments = z.infer<typeof ApartmentsSchema>

export const ApartmentInfoSchema = z.object({ id: z.number(), guests: z.number() })

export const GridEventSchema = z.object({
  id: z.number(),
  status: z.string(),
  begin_date: date,
  end_date: date,
  amount: z.number(),
  prepayment: z.number(),
  is_external: z.boolean(),
  is_delete: z.boolean(),
  source_id: z.number().nullable(),
  arrival_time: text,
  departure_time: text,
  client: z.object({ fio: text, phone: text }).nullable(),
  short_notes: text, // = the booking's notes (the detail's `notes`)
  updated_at: z.string(),
})
export type GridEvent = z.infer<typeof GridEventSchema>

export const SpecialPriceSchema = z.object({
  begin_date: date,
  end_date: date,
  closed: flag,
  is_delete: z.boolean(),
})
export type SpecialPrice = z.infer<typeof SpecialPriceSchema>

export const GridSchema = z.object({
  items: z.array(
    z.object({
      apartment_id: z.number(),
      room_id: z.number().nullable(),
      events: z.array(GridEventSchema),
      special_prices: z.array(SpecialPriceSchema),
    }),
  ),
})
export type Grid = z.infer<typeof GridSchema>

export const PriceSchema = z.object({ price: z.number() })

const actual = <T extends z.ZodType>(t: T) => z.object({ actual: t })
export const StayRulesSchema = z.object({
  apartments: z.array(
    z.object({
      id: z.number(),
      prices: z.array(
        z.object({
          date,
          min_stay_through: actual(z.number().nullable()),
          closed: actual(flag),
          closed_on_arrivial: actual(flag),
          closed_on_departure: actual(flag),
        }),
      ),
    }),
  ),
})
export type StayRules = z.infer<typeof StayRulesSchema>

const person = z.object({ id: z.number().nullable(), fio: text, phone: text, email: text })

export const BookingSchema = z.object({
  id: z.number(),
  status: z.string(),
  begin_date: date,
  end_date: date,
  apartment_id: z.number(),
  realty_room_id: z.number().nullable(),
  is_delete: z.boolean(),
  is_external: z.boolean(),
  updated_at: z.string(),
  amount: z.number(),
  notes: text,
  source_id: z.number().nullable(),
  arrival_time: text,
  departure_time: text,
  platform_name: text,
  client: person.nullable(),
  guest: person.nullable(),
  external: z
    .object({
      fields: z
        .array(z.object({ title: z.string(), value: z.unknown() }))
        .nullable()
        .optional(),
    })
    .nullable(),
  audits: z.array(z.object({ version: z.number(), created_at: z.string() })),
})
export type Booking = z.infer<typeof BookingSchema>

const personFull = person.extend({ additional_phone: text })

/** A booking read for a write: the fields the PUT body is built from, unknown keys kept for the drift check. */
export const BookingRawSchema = BookingSchema.extend({
  client: personFull.nullable(),
  guest: personFull.nullable(),
  color: z.string().nullable(),
  reaction: z.string().nullable(),
  platform_tax: z.number().nullable(),
  additional_services: z.object({ early_checkin: z.unknown(), late_checkout: z.unknown() }),
}).loose()
export type BookingRaw = z.infer<typeof BookingRawSchema>

/** POST event_calendars returns the draft in the detail shape; only the id is used. */
export const DraftSchema = z.object({ id: z.number() })

export const PaymentsSchema = z.object({
  data: z.array(
    z.object({
      id: z.number(),
      created_at: z.string(),
      note: text,
      status: z.object({ text: text }),
      payment: z.object({ type: z.string(), amount: z.number() }),
      invoice: z.object({ id: z.number(), title: z.string() }).nullable(),
    }),
  ),
})
export type Payments = z.infer<typeof PaymentsSchema>

export const SignInSchema = z.object({ auth_token: z.string(), success: z.boolean().optional() })
