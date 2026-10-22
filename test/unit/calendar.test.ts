import { describe, expect, it } from 'vitest'
import { memoryCache } from '../../src/cache.js'
import { parseConfig } from '../../src/config.js'
import { makeContext } from '../../src/context.js'
import { availability } from '../../src/domain/calendar.js'
import { resolveCategories } from '../../src/domain/catalog.js'
import { getGrid, getStayRules } from '../../src/upstream/api.js'
import { fakeRc, type ExtraEvent } from '../fake-rc.js'

const CAT01 = 810000052 // rooms 5 (810000029), 6 (810000030)

async function check(checkIn: string, checkOut: string, category: string, extraEvents: ExtraEvent[] = []) {
  const rc = fakeRc({ extraEvents })
  const ctx = makeContext('t', parseConfig({}), memoryCache(), { fetch: rc.fetch })
  const catalog = await ctx.catalog()
  const categories = resolveCategories(catalog, category)
  const ids = categories.map((c) => c.id)
  const grid = await getGrid(ctx.rc, {
    begin: checkIn,
    end: checkOut,
    statuses: ['booked', 'request'],
    apartmentIds: ids,
  })
  const stayRules = await getStayRules(ctx.rc, { begin: checkIn, end: checkOut, apartmentIds: ids })
  return availability({ catalog, categories, grid, stayRules, prices: new Map(), checkIn, checkOut, detail: 'rooms' })
}

describe('availability', () => {
  it('free category', async () => {
    const [a] = await check('2055-01-20', '2055-01-23', '01')
    expect(a).toMatchObject({ bookable_count: 2, bookable_rooms: ['5', '6'], empty_rooms: ['5', '6'], held_rooms: [] })
    expect(a!.rooms![0]!.runs).toEqual([{ from: '2055-01-20', to: '2055-01-23', state: 'free' }])
  })

  it('a booked room', async () => {
    const [a] = await check('2054-12-31', '2055-01-02', '01')
    expect(a).toMatchObject({ bookable_count: 1, bookable_rooms: ['5'], empty_rooms: ['5'] })
    expect(a!.rooms![1]).toMatchObject({ room: '6', bookable: false, reason: 'booked' })
    expect(a!.rooms![1]!.runs[0]).toMatchObject({ state: 'booked', guest_name: expect.any(String) })
  })

  it('unassigned bookings fill the category although rooms look empty', async () => {
    const un = { apartment_id: CAT01, room_id: null, begin_date: '2055-01-20', end_date: '2055-01-23' }
    const [a] = await check('2055-01-21', '2055-01-22', '01', [un, { ...un, begin_date: '2055-01-21' }])
    expect(a).toMatchObject({ bookable_count: 0, bookable_rooms: [], empty_rooms: ['5', '6'] })
    expect(a!.rooms!.map((r) => r.reason)).toEqual(['category_full', 'category_full'])
    expect(a!.unassigned).toHaveLength(2)
    expect(a!.unassigned![0]).toMatchObject({ unassigned: true, room: null })
  })

  it('holds do not block but are reported', async () => {
    const hold = {
      apartment_id: CAT01,
      room_id: 810000030,
      status: 'request',
      begin_date: '2055-01-20',
      end_date: '2055-01-21',
    }
    const [a] = await check('2055-01-20', '2055-01-23', '01', [hold, { ...hold, room_id: null }])
    expect(a).toMatchObject({ bookable_count: 2, bookable_rooms: ['5', '6'], held_rooms: ['6'] })
    expect(a!.rooms![1]!.runs.map((r) => r.state)).toEqual(['hold', 'free'])
  })

  it('a single-unit category is one unit and has no unassigned bookings', async () => {
    const [busy] = await check('2055-01-12', '2055-01-14', 'коттедж')
    expect(busy).toMatchObject({ single_unit: true, capacity: 1, bookable_count: 0 })
    expect(busy!.unassigned).toBeUndefined()
    expect(busy!.unit_runs![0]).toMatchObject({ state: 'booked' })
    const [free] = await check('2055-01-20', '2055-01-23', 'коттедж')
    expect(free).toMatchObject({ bookable_count: 1 })
  })

  it('closed rooms are not bookable', async () => {
    const [a] = await check('2055-04-05', '2055-04-07', '01')
    expect(a).toMatchObject({ bookable_count: 0, bookable_rooms: [] })
    expect(a!.rooms!.map((r) => r.reason)).toEqual(['closed', 'closed'])
  })

  it('reports the New Year min stay (R1, R3)', async () => {
    const [a] = await check('2054-12-31', '2055-01-01', '02')
    expect(a!.stay_rules).toMatchObject({ min_stay: 3, stay_ok: false, problems: ['min stay 3 nights'] })
    const [b] = await check('2054-12-28', '2054-12-30', '02')
    expect(b!.stay_rules.runs.map((r) => r.min_stay)).toEqual([2, 3])
  })

  it('selects categories for a guest count by max_guests', async () => {
    const rc = fakeRc()
    const ctx = makeContext('t', parseConfig({}), memoryCache(), { fetch: rc.fetch })
    const catalog = await ctx.catalog()
    expect(catalog.categories.filter((c) => c.maxGuests >= 3).map((c) => c.number)).toEqual(['05', '08', '09'])
  })
})
