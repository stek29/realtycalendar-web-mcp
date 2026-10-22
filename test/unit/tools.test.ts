// The read tools against the fake RC, following the spec §3 prompts (today = Thu 2054-10-22).
import { describe, expect, it } from 'vitest'
import { memoryCache } from '../../src/cache.js'
import { parseConfig, type Access } from '../../src/config.js'
import { makeContext } from '../../src/context.js'
import { createMcpServer, runTool, TOOLS } from '../../src/mcp/server.js'
import { fakeRc, type ExtraEvent } from '../fake-rc.js'

const NOW = new Date('2054-10-22T09:00:00+03:00')

function setup(access: Access = 'read', extraEvents: ExtraEvent[] = []) {
  const rc = fakeRc({ extraEvents })
  const lines: string[] = []
  const ctx = makeContext('test-token', parseConfig({ RC_ACCESS: access }), memoryCache(), {
    fetch: rc.fetch,
    now: () => NOW,
    log: { log: (level, event, fields) => lines.push(JSON.stringify({ level, event, ...fields })) },
  })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const call = async (name: string, args: Record<string, unknown> = {}): Promise<any> => {
    const tool = TOOLS.find((t) => t.name === name)!
    const res = await runTool(ctx, tool, args)
    const body = JSON.parse((res.content[0] as { text: string }).text)
    if (!res.isError) expect(tool.output.safeParse(res.structuredContent).success).toBe(true)
    return res.isError ? { isError: true, ...body } : body
  }
  return { call, rc, lines, ctx }
}

describe('server', () => {
  it('registers only the read tools at access=read and states what it cannot do', () => {
    const { ctx } = setup('read')
    const server = createMcpServer(ctx)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const registered = Object.keys((server as any)._registeredTools)
    expect(registered.sort()).toEqual(['check_availability', 'get_booking', 'list_bookings', 'list_rooms'])
  })
})

describe('list_rooms (U1c)', () => {
  it('lists categories and rooms', async () => {
    const { call } = setup()
    const r = await call('list_rooms')
    expect(r.categories).toHaveLength(9)
    expect(r.categories[3]).toMatchObject({ number: '04', single_unit: true, capacity: 1, rooms: [] })
  })
})

describe('check_availability', () => {
  it('U1a weekend: every category with prices and the dates used', async () => {
    const { call } = setup()
    const r = await call('check_availability', { check_in: '2054-10-23', check_out: '2054-10-25' })
    expect(r).toMatchObject({
      nights: 2,
      check_in_weekday: 'пт',
      check_out_weekday: 'вс',
      today: '2054-10-22',
      currency: '₽',
    })
    expect(r.categories).toHaveLength(9)
    expect(r.categories[0].price_total).toBeGreaterThan(0)
    expect(r.categories[0].rooms).toBeUndefined() // summary by default
  })

  it('U1b category words match several categories', async () => {
    const { call } = setup()
    const r = await call('check_availability', {
      check_in: '2054-11-07',
      check_out: '2054-11-09',
      category: 'двухместный',
    })
    expect(r.matched_categories.length).toBeGreaterThan(1)
    expect(r.categories[0].rooms).toBeDefined()
  })

  it('U2 one room: its category only, with runs', async () => {
    const { call } = setup()
    const r = await call('check_availability', { check_in: '2054-11-08', check_out: '2054-11-09', room: '22' })
    expect(r.categories).toHaveLength(1)
    expect(r.categories[0].category).toMatch(/^02 /)
    expect(r.categories[0].rooms.map((x: { room: string }) => x.room)).toEqual(['22'])
  })

  it('room and category must agree', async () => {
    const { call } = setup()
    const r = await call('check_availability', {
      check_in: '2054-11-08',
      check_out: '2054-11-09',
      room: '22',
      category: '01',
    })
    expect(r).toMatchObject({ isError: true, error: 'ROOM_NOT_IN_CATEGORY' })
  })

  it('R1/R3 New Year min stay', async () => {
    const { call } = setup()
    const r = await call('check_availability', { check_in: '2054-12-31', check_out: '2055-01-01', room: '22' })
    expect(r.categories[0].stay_rules).toMatchObject({ min_stay: 3, stay_ok: false })
  })

  it('R2 three guests: only 05, 08, 09', async () => {
    const { call } = setup()
    const r = await call('check_availability', { check_in: '2054-11-07', check_out: '2054-11-09', guests: 3 })
    expect(r.categories.map((c: { category: string }) => c.category.slice(0, 2))).toEqual(['05', '08', '09'])
  })

  it('Q1 price of room 5 on 20–23 January', async () => {
    const { call } = setup()
    const r = await call('check_availability', { check_in: '2055-01-20', check_out: '2055-01-23', room: '5' })
    expect(r.categories[0]).toMatchObject({ price_total: 33000, price_per_night: 11000 })
  })

  it('rejects bad ranges', async () => {
    const { call } = setup()
    expect(await call('check_availability', { check_in: '2054-11-09', check_out: '2054-11-09' })).toMatchObject({
      error: 'INVALID_DATES',
    })
    expect(await call('check_availability', { check_in: '2054-11-01', check_out: '2055-02-01' })).toMatchObject({
      error: 'RANGE_TOO_LONG',
    })
    expect(
      await call('check_availability', { check_in: '2054-11-01', check_out: '2054-11-02', category: 'люкс' }),
    ).toMatchObject({
      error: 'UNKNOWN_NAME',
      known: expect.any(Array),
    })
  })
})

describe('list_bookings', () => {
  it('U3b who is staying today (defaults)', async () => {
    const { call } = setup()
    const r = await call('list_bookings')
    expect(r).toMatchObject({ from: '2054-10-22', to: '2054-10-23', match: 'staying' })
    for (const b of r.bookings) expect(b.check_in <= '2054-10-22' && b.check_out > '2054-10-22').toBe(true)
  })

  it('U4a arriving tomorrow', async () => {
    const { call } = setup()
    const r = await call('list_bookings', { from: '2054-10-24', match: 'arriving' })
    expect(r.matched).toBeGreaterThan(0)
    expect(r.bookings.every((b: { check_in: string }) => b.check_in === '2054-10-24')).toBe(true)
  })

  it('U4b departing: sorted by check_out, includes stays that started earlier', async () => {
    const { call } = setup()
    const r = await call('list_bookings', { from: '2054-11-08', to: '2054-11-10', match: 'departing' })
    expect(
      r.bookings.every((b: { check_out: string }) => b.check_out >= '2054-11-08' && b.check_out < '2054-11-10'),
    ).toBe(true)
    expect(r.matched).toBeGreaterThan(0)
  })

  it('U4c / U12b unpaid with totals', async () => {
    const { call } = setup()
    const r = await call('list_bookings', { from: '2054-11-01', to: '2054-12-01', unpaid_only: true })
    expect(r.bookings.every((b: { left: number }) => b.left > 0)).toBe(true)
    expect(r.totals.left).toBe(r.bookings.reduce((s: number, b: { left: number }) => s + b.left, 0))
  })

  it('U9 source filter in Russian', async () => {
    const { call } = setup()
    const r = await call('list_bookings', { from: '2054-10-22', to: '2055-04-20', source: 'островок' })
    expect(r.matched).toBeGreaterThan(0)
    expect(r.bookings.every((b: { source: string }) => b.source === 'Ostrovok.ru')).toBe(true)
  })

  it('U10a unassigned only, never single-unit bookings', async () => {
    const { call } = setup()
    const r = await call('list_bookings', { from: '2054-10-22', to: '2055-04-20', unassigned_only: true })
    expect(r.matched).toBeGreaterThan(0)
    expect(r.bookings.every((b: { unassigned: boolean; room: null }) => b.unassigned && b.room === null)).toBe(true)
  })

  it('U3c guest name with a Russian ending', async () => {
    const { call } = setup('read', [
      {
        apartment_id: 810000052,
        room_id: 810000029,
        begin_date: '2055-01-20',
        end_date: '2055-01-23',
        client: { fio: 'Анна Петрова', phone: '+79990009999' },
      },
    ])
    const r = await call('list_bookings', { from: '2054-10-22', to: '2055-04-20', query: 'Петровой' })
    expect(r.bookings.map((b: { guest_name: string }) => b.guest_name)).toContain('Анна Петрова')
    const p = await call('list_bookings', { from: '2054-10-22', to: '2055-04-20', query: '8 999 000-99-99' })
    expect(p.matched).toBe(1)
  })

  it('holds only', async () => {
    const { call } = setup('read', [
      {
        apartment_id: 810000052,
        room_id: 810000029,
        status: 'request',
        begin_date: '2055-01-20',
        end_date: '2055-01-23',
      },
    ])
    const r = await call('list_bookings', { from: '2055-01-01', to: '2055-02-01', status: ['request'] })
    expect(r.bookings.map((b: { status: string }) => b.status)).toEqual(['request'])
  })

  it('limits returned rows but totals all matches', async () => {
    const { call } = setup()
    const r = await call('list_bookings', { from: '2054-10-22', to: '2055-04-20', limit: 3 })
    expect(r.returned).toBe(3)
    expect(r.totals.bookings).toBe(r.matched)
  })
})

describe('get_booking (U12a)', () => {
  it('returns money and booking-site details', async () => {
    const { call } = setup()
    const r = await call('get_booking', { booking_id: 810000162 })
    expect(r).toMatchObject({ total: 24000, paid: 24000, left: 0, paid_in_full: true, currency: '₽' })
    expect(r.booking_site.untrusted.fields['Дата бронирования']).toBeDefined()
  })

  it('unknown id → NOT_FOUND', async () => {
    const { call } = setup()
    expect(await call('get_booking', { booking_id: 1 })).toMatchObject({ isError: true, error: 'NOT_FOUND' })
  })
})

describe('logging', () => {
  it('never logs guest data or the token', async () => {
    const { call, lines } = setup()
    await call('list_bookings', { from: '2054-10-22', to: '2055-04-20', query: 'Иван' })
    await call('get_booking', { booking_id: 810000162 })
    await call('get_booking', { booking_id: 1 })
    const log = lines.join('\n')
    expect(lines.length).toBeGreaterThan(0)
    expect(log).not.toMatch(/test-token|Иван|\+7999/)
  })
})
