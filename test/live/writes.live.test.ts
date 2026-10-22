// Live write tests L1–L13 (plan-m2.md "Live tests") against the real account. Opt-in:
//   RC_LIVE=1 RC_TOKEN=… npm run test:live
// Approved scope (D24): "TEST MCP" guests, dates 2055-01-20 … 2055-01-23 only. The safety rules are enforced here in
// code: a write firewall in the fetch wrapper, a pre-check that the window is empty, and cleanup with a final check.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { memoryCache } from '../../src/cache.js'
import { parseConfig } from '../../src/config.js'
import { makeContext, type Context } from '../../src/context.js'
import { runTool, TOOLS } from '../../src/mcp/server.js'
import { ToolError } from '../../src/domain/errors.js'
import { getBookingRaw, getGrid } from '../../src/upstream/api.js'

const LIVE = process.env.RC_LIVE === '1'
const FIRST = '2055-01-20'
const LAST = '2055-01-23'
const PREFIX = 'TEST MCP'
const GUEST = { guest_phone: '+79990000001', guest_email: 'test-mcp@example.com' }

// Real id of category 02 (catalog of 2054-10-22).
const CAT_02 = 810000050

/** Booking ids this run may change or delete: created by it, or "TEST MCP" leftovers found by the pre-check. */
const owned = new Set<number>()

/** Writes the firewall refused; must stay empty. */
const violations: string[] = []

/** Rejects every write outside the approved scope before it reaches RC. */
function firewall(inner: typeof fetch): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input)
    const method = (init?.method ?? 'GET').toUpperCase()
    const path = url.pathname.replace(/^\/v2\//, '')
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined
    const inWindow = (ec: Record<string, unknown>) =>
      typeof ec.begin_date === 'string' &&
      typeof ec.end_date === 'string' &&
      ec.begin_date >= FIRST &&
      ec.end_date <= LAST
    const reject = (why: string): never => {
      violations.push(`${method} ${path}: ${why}`)
      throw new Error(`write firewall: ${method} ${path}: ${why}`)
    }

    if (method === 'GET' || (method === 'POST' && path === 'events/group_special_prices/prices')) {
      return inner(input, init)
    }
    const id = Number(path.match(/^event_calendars\/(\d+)$/)?.[1] ?? NaN)
    if (method === 'POST' && path === 'event_calendars') {
      if (!inWindow((body?.event_calendar ?? {}) as Record<string, unknown>)) reject('dates outside the window')
      const res = await inner(input, init)
      const draft = (await res.clone().json()) as { id?: number }
      if (typeof draft.id === 'number') owned.add(draft.id)
      return res
    }
    if (method === 'PUT' && owned.has(id)) {
      const ec = (body?.event_calendar ?? {}) as Record<string, { fio?: string } | unknown>
      const names = [(ec.guest as { fio?: string })?.fio, (ec.client as { fio?: string })?.fio]
      if (!names.every((n) => typeof n === 'string' && n.startsWith(PREFIX))) reject('guest is not a TEST MCP guest')
      if (!inWindow(ec)) reject('dates outside the window')
      return inner(input, init)
    }
    if (method === 'DELETE' && owned.has(id)) return inner(input, init)
    return reject('not allowed')
  }) as typeof fetch
}

/** Every booking (any status) overlapping 19–24 Jan 2055 in any category. */
async function windowBookings(ctx: Context) {
  const ids = (await ctx.catalog()).categories.map((c) => c.id)
  const grid = await getGrid(ctx.rc, {
    begin: '2055-01-19',
    end: '2055-01-24',
    statuses: ['booked', 'request', 'canceled'],
    apartmentIds: ids,
  })
  return grid.items.flatMap((row) =>
    row.events.filter((e) => !e.is_delete).map((e) => ({ id: e.id, fio: e.client?.fio ?? '', status: e.status })),
  )
}

describe.skipIf(!LIVE)('live writes L1–L13', { timeout: 60_000 }, () => {
  const ctx = makeContext(
    process.env.RC_TOKEN ?? '',
    parseConfig({ RC_ACCESS: 'full', RC_CONFIRM_KEY: 'live-test' }),
    memoryCache(),
    { fetch: firewall(globalThis.fetch.bind(globalThis)) },
  )
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const call = async (name: string, args: Record<string, unknown>): Promise<any> => {
    const res = await runTool(
      ctx,
      TOOLS.find((t) => t.name === name)!,
      args,
    )
    const body = JSON.parse((res.content[0] as { text: string }).text)
    return res.isError ? { isError: true, ...body } : body
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const write = async (name: string, args: Record<string, unknown>): Promise<any> => {
    const preview = await call(name, args)
    expect(preview.confirm_token, JSON.stringify(preview.warnings ?? preview)).toBeTruthy()
    const done = await call(name, { ...args, confirm_token: preview.confirm_token })
    expect(done.preview, JSON.stringify(done)).toBe(false)
    return { preview, done }
  }
  const codes = (r: { warnings?: { code: string }[] }) => (r.warnings ?? []).map((w) => w.code)
  /** Raw GET minus what always moves. */
  const raw = async (id: number) => {
    const { updated_at: _u, audits: _a, ...rest } = await getBookingRaw(ctx.rc, id)
    return rest as Record<string, unknown>
  }
  const changedKeys = (a: Record<string, unknown>, b: Record<string, unknown>) =>
    Object.keys({ ...a, ...b }).filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]))

  let l1 = 0
  let hold = 0
  let occupier = 0

  /** Soft-deletes a booking unless it is a draft (404) or already deleted. */
  async function remove(id: number): Promise<void> {
    let booking
    try {
      booking = await getBookingRaw(ctx.rc, id)
    } catch (e) {
      if (e instanceof ToolError && e.code === 'NOT_FOUND') return // a draft: can't be deleted (D19)
      throw e
    }
    if (!booking.is_delete) await ctx.rc.send('DELETE', `event_calendars/${id}`, undefined, z.unknown())
  }

  beforeAll(async () => {
    const found = await windowBookings(ctx)
    const foreign = found.filter((b) => !b.fio.startsWith(PREFIX))
    if (foreign.length) throw new Error(`pre-check: non-test bookings in the window: ${foreign.map((b) => b.id)}`)
    for (const b of found) owned.add(b.id)
    for (const b of found) await remove(b.id)
    expect(await windowBookings(ctx)).toEqual([])
  })

  afterAll(async () => {
    const failed: string[] = []
    for (const id of owned) await remove(id).catch((e) => failed.push(`${id}: ${e}`))
    const left = await windowBookings(ctx)
    console.log(`live cleanup: ids ${[...owned].join(', ')}; failures: ${failed.join('; ') || 'none'}`)
    expect(failed, 'delete failures').toEqual([])
    expect(left, 'bookings left in the window').toEqual([])
    expect(violations, 'firewall violations').toEqual([])
  })

  it('L1 create in room 5, 20–23 Jan, no price', async () => {
    const args = {
      room: '5',
      check_in: FIRST,
      check_out: LAST,
      guest_name: `${PREFIX} Иван`,
      arrival_time: '14:00',
      ...GUEST,
    }
    const { preview, done } = await write('create_booking', args)
    expect(preview).toMatchObject({ price_source: 'quote', will_fail: false })
    expect(preview.quote).toBeGreaterThan(0)
    l1 = done.booking.id
    expect(done.booking).toMatchObject({ room: '5', check_in: FIRST, check_out: LAST, total: preview.quote })
    expect(await call('get_booking', { booking_id: l1 })).toMatchObject({
      guest_name: `${PREFIX} Иван`,
      guest_phone: '+79990000001',
      guest_email: 'test-mcp@example.com',
      room: '5',
      arrival_time: '14:00',
    })
    const list = await call('list_bookings', { from: FIRST, to: LAST, query: PREFIX })
    expect(list.bookings.map((b: { id: number }) => b.id)).toContain(l1)
  })

  it('L2 the same create again → DUPLICATE, no token', async () => {
    const r = await call('create_booking', {
      room: '5',
      check_in: FIRST,
      check_out: LAST,
      guest_name: `${PREFIX} Иван`,
    })
    expect(codes(r)).toContain('DUPLICATE')
    expect(r.confirm_token).toBeUndefined()
  })

  it('L3 an overlapping create in room 5 → will_fail, no token', async () => {
    const r = await call('create_booking', {
      room: '5',
      check_in: '2055-01-21',
      check_out: LAST,
      guest_name: `${PREFIX} Пётр`,
    })
    expect(r).toMatchObject({ will_fail: true })
    expect(r.confirm_token).toBeUndefined()
    expect(r.conflicts.map((c: { id: number }) => c.id)).toEqual([l1])
  })

  it('L4 room 6 taken between preview and confirm → OCCUPIED, nothing saved', async () => {
    const args = { room: '6', check_in: FIRST, check_out: LAST, guest_name: `${PREFIX} Анна` }
    const first = await call('create_booking', args)
    expect(first.confirm_token).toBeTruthy()
    const { done } = await write('create_booking', { ...args, guest_name: `${PREFIX} Борис` })
    occupier = done.booking.id
    const r = await call('create_booking', { ...args, confirm_token: first.confirm_token })
    expect(r).toMatchObject({ isError: true, error: 'OCCUPIED' })
    expect(r.message).toMatch(/Nothing was saved/)
    const list = await call('list_bookings', { from: FIRST, to: LAST, query: `${PREFIX} Анна` })
    expect(list.bookings).toEqual([])
    // Free room 6 again for L7.
    await write('cancel_booking', { booking_id: occupier })
  })

  it('L5 a hold in category 01 without a room: unassigned, capacity unchanged', async () => {
    const before = await call('check_availability', { check_in: FIRST, check_out: LAST, category: '01' })
    const { done } = await write('create_booking', {
      category: '01',
      check_in: FIRST,
      check_out: LAST,
      status: 'request',
      guest_name: `${PREFIX} Заявка`,
    })
    hold = done.booking.id
    expect(done.booking).toMatchObject({ status: 'request', room: null, unassigned: true })
    const after = await call('check_availability', { check_in: FIRST, check_out: LAST, category: '01' })
    expect(after.categories[0].unassigned.map((b: { id: number }) => b.id)).toContain(hold)
    expect(after.categories[0].bookable_count).toBe(before.categories[0].bookable_count)
  })

  it('L6 update L1 dates 20–23 → 21–23: PRICE_CHANGED, average × 2', async () => {
    const old = (await call('get_booking', { booking_id: l1 })).total
    const { preview, done } = await write('update_booking', { booking_id: l1, check_in: '2055-01-21' })
    expect(codes(preview)).toContain('PRICE_CHANGED')
    expect(done.booking).toMatchObject({ check_in: '2055-01-21', total: Math.round((old / 3) * 2) })
  })

  it('L7 assign the hold to room 6, then confirm it', async () => {
    const assigned = await write('update_booking', { booking_id: hold, room: '6' })
    expect(assigned.done.booking).toMatchObject({ room: '6', status: 'request' })
    const confirmed = await write('update_booking', { booking_id: hold, status: 'booked' })
    expect(confirmed.done.booking).toMatchObject({ room: '6', status: 'booked' })
  })

  it('L8 move L1 to room 21 (category 02): CATEGORY_CHANGE, PRICE_KEPT', async () => {
    const { preview, done } = await write('update_booking', { booking_id: l1, room: '21' })
    expect(codes(preview)).toEqual(expect.arrayContaining(['CATEGORY_CHANGE', 'PRICE_KEPT']))
    expect(done.booking).toMatchObject({ room: '21', category_id: CAT_02, total: preview.before.total })
    expect((await getBookingRaw(ctx.rc, l1)).apartment_id).toBe(CAT_02)
  })

  it('L9 unassign, notes_append, clear arrival time: only those fields change', async () => {
    const steps: [Record<string, unknown>, string[]][] = [
      [{ unassign: true }, ['realty_room_id', 'realty_room_title']],
      [{ notes_append: 'L9 заметка' }, ['notes']],
      [{ clear_arrival_time: true }, ['arrival_time']],
    ]
    for (const [change, keys] of steps) {
      const before = await raw(l1)
      await write('update_booking', { booking_id: l1, ...change })
      const diff = changedKeys(before, await raw(l1))
      expect(
        diff.filter((k) => !keys.includes(k)),
        JSON.stringify(change),
      ).toEqual([])
    }
    expect(await call('get_booking', { booking_id: l1 })).toMatchObject({
      room: null,
      unassigned: true,
      category_id: CAT_02,
      arrival_time: null,
      guest_name: `${PREFIX} Иван`,
      guest_phone: '+79990000001',
    })
  })

  it('L10 booking changed after a preview → PREVIEW_STALE with a fresh preview', async () => {
    const args = { booking_id: l1, departure_time: '11:00' }
    const first = await call('update_booking', args)
    await write('update_booking', { booking_id: l1, notes_append: 'L10' })
    const r = await call('update_booking', { ...args, confirm_token: first.confirm_token })
    expect(r).toMatchObject({ isError: true, error: 'PREVIEW_STALE', preview: { preview: true } })
    expect((await call('get_booking', { booking_id: l1 })).departure_time).toBeNull()
  })

  it('L11 single unit: an overlapping second booking in category 04 → will_fail', async () => {
    const args = { category: '04', check_in: FIRST, check_out: LAST, guest_name: `${PREFIX} Коттедж` }
    await write('create_booking', args)
    const r = await call('create_booking', { ...args, check_in: '2055-01-21', guest_name: `${PREFIX} Коттедж 2` })
    expect(r.will_fail).toBe(true)
    expect(r.confirm_token).toBeUndefined()
  })

  it('L12 cancel L1: canceled, category 02 bookable again', async () => {
    const { done } = await write('cancel_booking', { booking_id: l1 })
    expect(done.booking.status).toBe('canceled')
    const a = await call('check_availability', { check_in: '2055-01-21', check_out: LAST, category: '02' })
    expect(a.categories[0]).toMatchObject({ bookable_count: a.categories[0].capacity, unassigned: [] })
  })

  it('L13 delete the hold; then update it → DELETED', async () => {
    const { done } = await write('delete_booking', { booking_id: hold })
    expect(done).toMatchObject({ deleted: true })
    expect(await call('update_booking', { booking_id: hold, notes_append: 'x' })).toMatchObject({ error: 'DELETED' })
  })

  it('the firewall refuses writes outside the scope', async () => {
    const n = violations.length
    const post = ctx.rc.send(
      'POST',
      'event_calendars',
      { event_calendar: { begin_date: '2055-01-24', end_date: '2055-01-25' } },
      z.unknown(),
    )
    await expect(post).rejects.toThrow()
    await expect(ctx.rc.send('DELETE', 'event_calendars/1', undefined, z.unknown())).rejects.toThrow()
    expect(violations).toHaveLength(n + 2)
    violations.length = n // expected refusals
  })
})
