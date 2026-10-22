import { z } from 'zod'
import { defineTool, READ_ANNOTATIONS } from './define.js'

export const listRooms = defineTool({
  name: 'list_rooms',
  level: 'read',
  title: 'List rooms',
  description:
    "CATALOG. List the hotel's room categories and the rooms in each (типы номеров и номера), with ids and capacity. " +
    'Use for "какие у нас номера". Says nothing about availability — for that use check_availability.',
  input: z.object({}),
  output: z.object({
    categories: z.array(
      z.object({
        id: z.number(),
        number: z.string(),
        title: z.string(),
        short_title: z.string(),
        single_unit: z.boolean().describe('No rooms: the category itself is one bookable unit (e.g. коттедж)'),
        capacity: z.number().describe('Rooms in the category, or 1 for a single unit'),
        max_guests: z.number(),
        rooms: z.array(z.object({ id: z.number(), title: z.string() })),
      }),
    ),
  }),
  annotations: READ_ANNOTATIONS,
  async handler(ctx) {
    const catalog = await ctx.catalog()
    return {
      categories: catalog.categories.map((c) => ({
        id: c.id,
        number: c.number,
        title: c.title,
        short_title: c.shortTitle,
        single_unit: c.singleUnit,
        capacity: c.capacity,
        max_guests: c.maxGuests,
        rooms: c.rooms.map((r) => ({ id: r.id, title: r.title })),
      })),
    }
  },
})
