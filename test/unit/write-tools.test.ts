// The write tools against the fake RC, following the spec §3 write stories (today = Thu 2054-10-22).
import { describe, expect, it } from 'vitest'
import type { AuditEntry } from '../../src/audit.js'
import { memoryCache } from '../../src/cache.js'
import { parseConfig, type Access } from '../../src/config.js'
import { makeContext } from '../../src/context.js'
import { instructions } from '../../src/mcp/instructions.js'
import { createMcpServer, runTool, TOOLS } from '../../src/mcp/server.js'
import { fakeRc, type FakeRcOptions } from '../fake-rc.js'

const NOW = new Date('2054-10-22T09:00:00+03:00')

function setup(access: Access = 'full', opts: FakeRcOptions = {}, env: Record<string, string> = {}) {
  const rc = fakeRc(opts)
  const lines: string[] = []
  const audit: AuditEntry[] = []
  const config = parseConfig({ RC_ACCESS: access, RC_CONFIRM_KEY: 'k', ...env })
  const ctx = makeContext('test-token', config, memoryCache(), {
    fetch: rc.fetch,
    now: () => NOW,
    log: { log: (level, event, fields) => lines.push(JSON.stringify({ level, event, ...fields })) },
    audit: { write: async (e) => void audit.push(e) },
  })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const call = async (name: string, args: Record<string, unknown> = {}): Promise<any> => {
    const tool = TOOLS.find((t) => t.name === name)!
    const res = await runTool(ctx, tool, args)
    const body = JSON.parse((res.content[0] as { text: string }).text)
    if (!res.isError) expect(tool.output.safeParse(res.structuredContent).success).toBe(true)
    return res.isError ? { isError: true, ...body } : body
  }
  /** Preview, then confirm with the preview's token. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const write = async (name: string, args: Record<string, unknown>): Promise<any> => {
    const preview = await call(`preview_${name}`, args)
    expect(preview.confirm_token, JSON.stringify(preview)).toBeTruthy()
    return call(name, { ...args, confirm_token: preview.confirm_token })
  }
  const writes = () => rc.calls.filter((c) => !c.startsWith('GET') && !c.includes('group_special_prices'))
  return { call, write, writes, rc, lines, ctx, audit }
}

const ALLOW_SITE = { RC_SITE_BOOKINGS: 'allow' }

const codes = (r: { warnings: { code: string }[] }) => r.warnings.map((w) => w.code)

const ANNA = {
  room: '22',
  check_in: '2054-11-08',
  check_out: '2054-11-10',
  guest_name: 'Анна Петрова',
  guest_phone: '+7 900 123-45-67',
}

describe('access levels (X5, X7)', () => {
  it.each([
    ['read', ['check_availability', 'get_booking', 'list_bookings', 'list_rooms']],
    [
      'book',
      ['check_availability', 'create_booking', 'get_booking', 'list_bookings', 'list_rooms', 'preview_create_booking'],
    ],
    [
      'edit',
      [
        'cancel_booking',
        'check_availability',
        'create_booking',
        'get_booking',
        'list_bookings',
        'list_rooms',
        'preview_cancel_booking',
        'preview_create_booking',
        'preview_update_booking',
        'update_booking',
      ],
    ],
  ] as const)('%s registers only its tools', (access, tools) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const registered = Object.keys((createMcpServer(setup(access).ctx) as any)._registeredTools)
    expect(registered.sort()).toEqual(tools)
  })

  it('X5: create at read → ACCESS_DENIED, nothing sent', async () => {
    const { call, writes } = setup('read')
    expect(await call('preview_create_booking', ANNA)).toMatchObject({ isError: true, error: 'ACCESS_DENIED' })
    expect(await call('create_booking', { ...ANNA, confirm_token: 'x' })).toMatchObject({ error: 'ACCESS_DENIED' })
    expect(writes()).toEqual([])
  })

  it('preview tools are read-only; every write tool is destructive (D34)', () => {
    for (const t of TOOLS.filter((t) => /_booking$/.test(t.name) && t.name !== 'get_booking')) {
      const preview = t.name.startsWith('preview_')
      expect(t.annotations, t.name).toMatchObject(
        preview ? { readOnlyHint: true } : { readOnlyHint: false, destructiveHint: true },
      )
    }
  })

  it('the user words are on the preview tool only; the write tool says it is step 2', () => {
    for (const t of TOOLS.filter((t) => t.annotations.destructiveHint)) {
      const preview = TOOLS.find((p) => p.name === `preview_${t.name}`)!
      expect(t.description, t.name).toMatch(/^Step 2 of 2\..*preview_/)
      expect(t.description, t.name).not.toMatch(/[а-я]/)
      expect(preview.description, preview.name).toMatch(/^Step 1 of 2, changes nothing\./)
    }
  })

  it('instructions follow the access level and RC_SITE_BOOKINGS', () => {
    const text = (env: Record<string, string>) => instructions('2054-10-22', parseConfig(env))
    expect(text({ RC_ACCESS: 'edit' })).toMatch(/SITE_BOOKING/)
    expect(text({ RC_ACCESS: 'edit', RC_SITE_BOOKINGS: 'allow' })).toMatch(/BOOKING_SITE warning/)
    expect(text({ RC_ACCESS: 'book' })).not.toMatch(/booking sites \(/)
    expect(text({ RC_ACCESS: 'read' })).not.toMatch(/preview_/)
  })

  it('X7: cancel at book → ACCESS_DENIED', async () => {
    const { call } = setup('book')
    expect(await call('preview_cancel_booking', { booking_id: 810000162 })).toMatchObject({ error: 'ACCESS_DENIED' })
  })
})

describe('create_booking', () => {
  it('U5a: preview changes nothing; confirm creates the booking', async () => {
    const { call, writes } = setup()
    const preview = await call('preview_create_booking', ANNA)
    expect(writes()).toEqual([])
    expect(preview).toMatchObject({ preview: true, before: null, will_fail: false, price_source: 'quote' })
    expect(preview.summary).toMatch(/^Бронь: 22, 8–10 ноября, Анна Петрова, [\d ]+ ₽$/)
    expect(preview.after).toMatchObject({ id: null, room: '22', nights: 2, total: preview.quote, paid: 0 })
    expect(codes(preview)).toContain('NO_GUEST_MESSAGES')

    const done = await call('create_booking', { ...ANNA, confirm_token: preview.confirm_token })
    expect(done).toMatchObject({ preview: false, booking: { room: '22', status: 'booked', total: preview.quote } })
    expect(writes().map((c) => c.split(' ')[0])).toEqual(['POST', 'PUT'])
    const id = done.booking.id

    expect(await call('get_booking', { booking_id: id })).toMatchObject({ guest_name: 'Анна Петрова', room: '22' })
    const found = await call('list_bookings', { from: '2054-10-22', to: '2055-01-01', query: 'Петрова' })
    expect(found.bookings.map((b: { id: number }) => b.id)).toContain(id)
  })

  it('U5b: several categories match → AMBIGUOUS; one category → unassigned booking', async () => {
    const { call, write } = setup()
    const args = {
      category: 'двухместную улучшенную',
      check_in: '2054-11-08',
      check_out: '2054-11-10',
      guest_name: 'Сидоров',
    }
    const amb = await call('preview_create_booking', args)
    expect(amb).toMatchObject({ isError: true, error: 'AMBIGUOUS' })
    expect(amb.candidates).toHaveLength(2)
    const done = await write('create_booking', { ...args, category: '02' })
    expect(done.booking).toMatchObject({ room: null, unassigned: true, category: expect.stringMatching(/^02 /) })
  })

  it('U5c: a hold in a single-unit category', async () => {
    const { write } = setup()
    const done = await write('create_booking', {
      category: 'коттедж',
      check_in: '2054-12-31',
      check_out: '2055-01-03',
      status: 'request',
      guest_name: 'Анна Петрова',
    })
    expect(done.booking).toMatchObject({ status: 'request', room: null, unassigned: false })
    expect(done.summary).toMatch(/^Создана заявка/)
  })

  it('a write without a token → VALIDATION pointing to the preview tool, nothing written', async () => {
    const { call, writes } = setup()
    const r = await call('create_booking', ANNA)
    expect(r).toMatchObject({ isError: true, error: 'VALIDATION' })
    expect(JSON.stringify(r)).toContain('preview_create_booking')
    expect(writes()).toEqual([])
  })

  it('U5d: a made-up token → PREVIEW_STALE with a preview, nothing written', async () => {
    const { call, writes } = setup()
    const r = await call('create_booking', { ...ANNA, confirm_token: 'abc.def' })
    expect(r).toMatchObject({ isError: true, error: 'PREVIEW_STALE', preview: { preview: true } })
    expect(r.preview.confirm_token).toBeTruthy()
    expect(writes()).toEqual([])
  })

  it('U5e: two previews, then two confirms', async () => {
    const { call } = setup()
    const a = { ...ANNA, guest_name: 'Смирнов' }
    const b = { ...a, room: '21' }
    const [pa, pb] = [await call('preview_create_booking', a), await call('preview_create_booking', b)]
    const ra = await call('create_booking', { ...a, confirm_token: pa.confirm_token })
    const rb = await call('create_booking', { ...b, confirm_token: pb.confirm_token })
    expect([ra.booking.room, rb.booking.room]).toEqual(['22', '21'])
    expect(ra.booking.id).not.toBe(rb.booking.id)
  })

  it('U11: price per night → total; NO_GUEST_MESSAGES', async () => {
    const { call } = setup()
    const p = await call('preview_create_booking', {
      room: '5',
      check_in: '2055-01-20',
      check_out: '2055-01-23',
      guest_name: 'Иван',
      price_per_night: 10000,
    })
    expect(p).toMatchObject({ price_source: 'per_night', after: { total: 30000 } })
    expect(p.summary).toMatch(/30 000 ₽$/)
    expect(codes(p)).toContain('NO_GUEST_MESSAGES')
  })

  it('DUPLICATE: the same create again → no token, nothing created', async () => {
    const { call, write, writes } = setup()
    const first = await write('create_booking', ANNA)
    const n = writes().length
    const again = await call('preview_create_booking', ANNA)
    expect(again.confirm_token).toBeUndefined()
    expect(codes(again)).toContain('DUPLICATE')
    expect(again.warnings[0].booking.id).toBe(first.booking.id)
    expect(writes()).toHaveLength(n)
  })

  it('an overlapping booked stay → will_fail, conflicts, no token', async () => {
    const { call, write } = setup()
    const first = await write('create_booking', ANNA)
    const p = await call('preview_create_booking', {
      ...ANNA,
      check_in: '2054-11-09',
      check_out: '2054-11-11',
      guest_name: 'Другой',
    })
    expect(p).toMatchObject({ will_fail: true })
    expect(p.confirm_token).toBeUndefined()
    expect(p.conflicts.map((c: { id: number }) => c.id)).toEqual([first.booking.id])
  })

  it('L11: single unit → an overlapping second booking will fail', async () => {
    const { call, write } = setup()
    const args = { category: '04', check_in: '2055-01-20', check_out: '2055-01-23', guest_name: 'TEST MCP Один' }
    await write('create_booking', args)
    const p = await call('preview_create_booking', { ...args, check_in: '2055-01-21', guest_name: 'TEST MCP Два' })
    expect(p.will_fail).toBe(true)
  })

  it('a hold over a booked stay: allowed, HOLD_OVERLAP on the next booking', async () => {
    const { call, write } = setup()
    await write('create_booking', { ...ANNA, status: 'request', guest_name: 'Заявка Тест' })
    const p = await call('preview_create_booking', ANNA)
    expect(p.will_fail).toBe(false)
    expect(codes(p)).toContain('HOLD_OVERLAP')
  })

  it('L4: room taken between preview and confirm → OCCUPIED, nothing saved, conflicts', async () => {
    const { call, write } = setup()
    const p = await call('preview_create_booking', ANNA)
    const other = await write('create_booking', { ...ANNA, guest_name: 'Быстрее' })
    const r = await call('create_booking', { ...ANNA, confirm_token: p.confirm_token })
    expect(r).toMatchObject({ isError: true, error: 'OCCUPIED' })
    expect(r.message).toMatch(/Nothing was saved/)
    expect(r.conflicts.map((c: { id: number }) => c.id)).toEqual([other.booking.id])
  })

  it.each([false, true])(
    'PUT timeout (saved: %s) → RC_ERROR; the repeat confirm never creates twice',
    async (saved) => {
      const { call, rc } = setup('full', { failNext: { method: 'PUT', with: 'timeout', saved } })
      const p = await call('preview_create_booking', ANNA)
      const r = await call('create_booking', { ...ANNA, confirm_token: p.confirm_token })
      expect(r).toMatchObject({ isError: true, error: 'RC_ERROR' })
      expect(r.hint).toMatch(/same confirm_token/)
      const again = await call('create_booking', { ...ANNA, confirm_token: p.confirm_token })
      expect(again.preview).toBe(false)
      if (saved) expect(again.note).toMatch(/already existed/)
      const list = await call('list_bookings', { from: '2054-11-08', query: 'Анна Петрова' })
      expect(list.bookings.filter((b: { room: string }) => b.room === '22')).toHaveLength(1)
      expect(rc.calls.filter((c) => c.startsWith('POST event_calendars'))).toHaveLength(saved ? 1 : 2)
    },
  )

  it('update: PUT timeout → RC_ERROR that says to check before retrying', async () => {
    const { call } = setup('full', { failNext: { method: 'PUT', with: 'timeout' } })
    const args = { booking_id: 810000176, notes_append: 'x' }
    const p = await call('preview_update_booking', args)
    expect(await call('update_booking', { ...args, confirm_token: p.confirm_token })).toMatchObject({
      error: 'RC_ERROR',
      message: expect.stringMatching(/may or may not have been saved/),
      hint: expect.stringMatching(/get_booking/),
    })
  })

  it('PUT 500 → RC_ERROR with the repeat hint', async () => {
    const { call } = setup('full', { failNext: { method: 'PUT', with: 500 } })
    const p = await call('preview_create_booking', ANNA)
    expect(await call('create_booking', { ...ANNA, confirm_token: p.confirm_token })).toMatchObject({
      error: 'RC_ERROR',
      hint: expect.stringMatching(/same confirm_token/),
    })
  })

  it.each([
    [{ ...ANNA, room: undefined }, 'VALIDATION'],
    [{ ...ANNA, guest_name: '  ' }, 'VALIDATION'],
    [{ ...ANNA, total: 1, price_per_night: 1 }, 'VALIDATION'],
    [{ ...ANNA, arrival_time: '25:00' }, 'VALIDATION'],
    [{ ...ANNA, check_out: '2054-11-08' }, 'INVALID_DATES'],
    [{ ...ANNA, check_out: '2055-02-07' }, 'RANGE_TOO_LONG'],
    [{ ...ANNA, category: '01' }, 'ROOM_NOT_IN_CATEGORY'],
    [{ ...ANNA, source: 'нет такого' }, 'UNKNOWN_NAME'],
  ])('input check %#', async (args, error) => {
    const { call } = setup()
    expect(await call('preview_create_booking', args)).toMatchObject({ isError: true, error })
  })
})

describe('update_booking', () => {
  /** A booking of our own in room 22, 9–11 Nov (2 nights). */
  async function booked() {
    const s = setup()
    const r = await s.write('create_booking', {
      ...ANNA,
      check_in: '2054-11-10',
      check_out: '2054-11-12',
      total: 20000,
    })
    return { ...s, id: r.booking.id as number }
  }

  it('U6a: move dates; occupied → will_fail without a token', async () => {
    const { call, write, id } = await booked()
    await write('create_booking', { ...ANNA, guest_name: 'Сосед' }) // 7–9 Nov in 22
    const blocked = await call('preview_update_booking', {
      booking_id: id,
      check_in: '2054-11-09',
      check_out: '2054-11-11',
    })
    expect(blocked).toMatchObject({ preview: true, will_fail: true })
    expect(blocked.confirm_token).toBeUndefined()

    const moved = await write('update_booking', { booking_id: id, check_in: '2054-11-11', check_out: '2054-11-13' })
    expect(moved.booking).toMatchObject({ check_in: '2054-11-11', check_out: '2054-11-13', total: 20000 })
  })

  it('U6b: extend → PRICE_CHANGED with old and new totals and the quote', async () => {
    const { call, id } = await booked()
    const p = await call('preview_update_booking', { booking_id: id, check_out: '2054-11-13' })
    const w = p.warnings.find((x: { code: string }) => x.code === 'PRICE_CHANGED')
    expect(w).toMatchObject({ old_total: 20000, new_total: 30000, quote: expect.any(Number) })
    expect(p.changes).toEqual([
      { field: 'check_out', from: '2054-11-12', to: '2054-11-13' },
      { field: 'total', from: 20000, to: 30000 },
    ])
    expect(p.summary).toMatch(
      /^Изменить бронь \d+ \(22, 10–12 ноября, Анна Петрова, 20 000 ₽\): выезд 2054-11-12 → 2054-11-13; сумма 20000 → 30000$/,
    )
  })

  it('U6f: notes_append keeps the old note', async () => {
    const { write, call } = setup()
    const r = await write('update_booking', { booking_id: 810000176, notes_append: 'Нужна детская кроватка' })
    expect(r.booking.untrusted.notes).toBe('[notes]\nНужна детская кроватка')
    expect((await call('get_booking', { booking_id: 810000176 })).untrusted.notes).toBe(
      '[notes]\nНужна детская кроватка',
    )
  })

  it('U6g: changed arguments after the preview → PREVIEW_STALE with a fresh preview', async () => {
    const { call, id, writes } = await booked()
    const p = await call('preview_update_booking', { booking_id: id, check_out: '2054-11-13' })
    const n = writes().length
    const r = await call('update_booking', { booking_id: id, check_out: '2054-11-14', confirm_token: p.confirm_token })
    expect(r).toMatchObject({ isError: true, error: 'PREVIEW_STALE', preview: { after: { check_out: '2054-11-14' } } })
    expect(writes()).toHaveLength(n)
  })

  it('the booking changed between preview and confirm → PREVIEW_STALE', async () => {
    const { call, write, id } = await booked()
    const p = await call('preview_update_booking', { booking_id: id, check_out: '2054-11-13' })
    await write('update_booking', { booking_id: id, arrival_time: '15:00' })
    const r = await call('update_booking', { booking_id: id, check_out: '2054-11-13', confirm_token: p.confirm_token })
    expect(r).toMatchObject({ error: 'PREVIEW_STALE' })
  })

  it('two confirms of one token at once: one PUT (confirms on a booking are serialised)', async () => {
    const { call, id, writes } = await booked()
    const args = { booking_id: id, check_out: '2054-11-13' }
    const token = (await call('preview_update_booking', args)).confirm_token
    const n = writes().length
    const confirm = () => call('update_booking', { ...args, confirm_token: token })
    const [a, b] = await Promise.all([confirm(), confirm()])
    expect(a.preview).toBe(false)
    expect(b.isError).toBe(true) // the second sees the saved change: nothing left to do
    expect(writes()).toHaveLength(n + 1)
  })

  it('U10b: room in another category → CATEGORY_CHANGE, PRICE_KEPT; apartment follows the room', async () => {
    const { call, write } = setup()
    const p = await call('preview_update_booking', { booking_id: 810000176, room: '23' })
    expect(codes(p)).toEqual(expect.arrayContaining(['CATEGORY_CHANGE', 'PRICE_KEPT']))
    expect(p.warnings.find((w: { code: string }) => w.code === 'PRICE_KEPT').quote).toEqual(expect.any(Number))
    const r = await write('update_booking', { booking_id: 810000176, room: '23' })
    expect(r.booking).toMatchObject({ room: '23', category: expect.stringMatching(/^03 /), total: p.before.total })
  })

  it('unassign; confirm a hold; clear arrival time — untouched fields stay', async () => {
    const { write, call } = setup()
    const hold = await write('create_booking', {
      ...ANNA,
      status: 'request',
      arrival_time: '14:00',
      departure_time: '11:00',
      notes: 'старая',
    })
    const id = hold.booking.id
    await write('update_booking', { booking_id: id, unassign: true })
    await write('update_booking', { booking_id: id, status: 'booked' })
    const r = await write('update_booking', { booking_id: id, clear_arrival_time: true })
    expect(r.booking).toMatchObject({
      status: 'booked',
      room: null,
      unassigned: true,
      arrival_time: null,
      departure_time: '11:00',
      guest_name: 'Анна Петрова',
      guest_phone: '+7 900 123-45-67',
      untrusted: { notes: 'старая' },
    })
    const detail = await call('get_booking', { booking_id: id })
    expect(detail.guest_name).toBe('Анна Петрова')
  })

  it('BOOKING_SITE on a booking-site booking (RC_SITE_BOOKINGS=allow)', async () => {
    const { call } = setup('full', {}, ALLOW_SITE)
    const p = await call('preview_update_booking', { booking_id: 810000162, check_out: '2055-01-09' })
    expect(codes(p)).toContain('BOOKING_SITE')
    const notes = await call('preview_update_booking', { booking_id: 810000162, notes_append: 'x' })
    expect(codes(notes)).not.toContain('BOOKING_SITE')
  })

  it.each([
    [{}, 'VALIDATION'],
    [{ room: '22', unassign: true }, 'VALIDATION'],
    [{ notes_append: 'a', notes_replace: 'b' }, 'VALIDATION'],
    [{ arrival_time: '12:00', clear_arrival_time: true }, 'VALIDATION'],
    [{ total: 1, price_per_night: 1 }, 'VALIDATION'],
    [{ check_out: '2054-12-20' }, 'INVALID_DATES'],
  ])('input check %#', async (changes, error) => {
    const { call } = setup()
    expect(await call('preview_update_booking', { booking_id: 810000162, ...changes })).toMatchObject({
      isError: true,
      error,
    })
  })

  it('nothing would change → VALIDATION', async () => {
    const { call } = setup()
    expect(await call('preview_update_booking', { booking_id: 810000162, check_in: '2054-12-20' })).toMatchObject({
      error: 'VALIDATION',
    })
  })

  it('unknown id → NOT_FOUND', async () => {
    const { call } = setup()
    expect(await call('preview_update_booking', { booking_id: 1, notes_append: 'x' })).toMatchObject({
      error: 'NOT_FOUND',
    })
  })
})

describe('RC_SITE_BOOKINGS=protect (default, D40)', () => {
  const SITE = 810000162 // Ostrovok, room 25, 2–8 Jan 2055

  it.each([
    [{ check_out: '2055-01-09' }, /check_out/],
    [{ total: 1000 }, /total/],
    [{ status: 'request' }, /status/],
    [{ category: '03' }, /category/],
    [{ room: '23' }, /category/],
  ])('refuses %o in preview and write', async (changes, field) => {
    const { call, writes } = setup()
    const p = await call('preview_update_booking', { booking_id: SITE, ...changes })
    expect(p).toMatchObject({ isError: true, error: 'SITE_BOOKING', platform: 'Ostrovok' })
    expect(p.message).toMatch(field)
    expect(await call('update_booking', { booking_id: SITE, ...changes, confirm_token: 'x.y' })).toMatchObject({
      error: 'SITE_BOOKING',
    })
    expect(writes()).toEqual([])
  })

  it('refuses cancel and delete', async () => {
    const { call } = setup()
    for (const tool of ['preview_cancel_booking', 'preview_delete_booking', 'cancel_booking']) {
      expect(await call(tool, { booking_id: SITE, confirm_token: 'x.y' })).toMatchObject({ error: 'SITE_BOOKING' })
    }
  })

  it('allows notes, times and a room in the same category', async () => {
    const { call, write } = setup()
    await write('update_booking', { booking_id: SITE, notes_append: 'x', arrival_time: '15:00' })
    const room = (await call('list_rooms')).categories
      .find((c: { rooms: { title: string }[] }) => c.rooms.some((r) => r.title === '25'))
      .rooms.find((r: { title: string }) => r.title !== '25').title
    const free = await call('preview_update_booking', { booking_id: SITE, room })
    expect(free.isError).toBeUndefined()
  })

  it('leaves bookings not from a booking site alone', async () => {
    const { call } = setup()
    expect((await call('preview_cancel_booking', { booking_id: 810000176 })).confirm_token).toBeTruthy()
  })
})

describe('cancel_booking and delete_booking', () => {
  it('U6c: cancel a booking-site booking with payments (RC_SITE_BOOKINGS=allow)', async () => {
    const { call, write } = setup('full', {}, ALLOW_SITE)
    const p = await call('preview_cancel_booking', { booking_id: 810000162 })
    expect(codes(p)).toEqual(expect.arrayContaining(['BOOKING_SITE', 'HAS_PAYMENTS']))
    expect(p.summary).toMatch(/^Отменить бронь 810000162: 25,/)
    const r = await write('cancel_booking', { booking_id: 810000162 })
    expect(r.booking.status).toBe('canceled')
    expect(await call('preview_cancel_booking', { booking_id: 810000162 })).toMatchObject({ error: 'VALIDATION' })
    const avail = await call('check_availability', { check_in: '2055-01-02', check_out: '2055-01-08', room: '25' })
    expect(avail.categories[0].rooms[0].runs.every((r: { state: string }) => r.state !== 'booked')).toBe(true)
  })

  it('U6d: delete; then update and delete again → DELETED', async () => {
    const { call, write } = setup('full', {}, ALLOW_SITE)
    const r = await write('delete_booking', { booking_id: 810000162 })
    expect(r).toMatchObject({ preview: false, deleted: true })
    expect(await call('preview_update_booking', { booking_id: 810000162, notes_append: 'x' })).toMatchObject({
      error: 'DELETED',
    })
    expect(await call('preview_delete_booking', { booking_id: 810000162 })).toMatchObject({ error: 'DELETED' })
  })

  it('deleted between preview and confirm → DELETED', async () => {
    const { call, write } = setup()
    const p = await call('preview_cancel_booking', { booking_id: 810000176 })
    await write('delete_booking', { booking_id: 810000176 })
    expect(await call('cancel_booking', { booking_id: 810000176, confirm_token: p.confirm_token })).toMatchObject({
      error: 'DELETED',
    })
  })
})

describe('audit log', () => {
  it('one entry per confirmed write, success and failure; previews write none', async () => {
    const { call, write, audit } = setup()
    const created = await write('create_booking', ANNA)
    await call('preview_update_booking', { booking_id: created.booking.id, notes_append: 'x' }) // preview only
    await write('update_booking', { booking_id: created.booking.id, notes_append: 'x' })
    const p = await call('preview_create_booking', { ...ANNA, room: '21' })
    await write('create_booking', { ...ANNA, room: '21', guest_name: 'Быстрее' })
    await call('create_booking', { ...ANNA, room: '21', confirm_token: p.confirm_token }) // OCCUPIED
    expect(audit.map((e) => [e.tool, e.result])).toEqual([
      ['create_booking', 'ok'],
      ['update_booking', 'ok'],
      ['create_booking', 'ok'],
      ['create_booking', 'OCCUPIED'],
    ])
    expect(audit[0]).toMatchObject({ booking_id: created.booking.id, rc_user_id: expect.any(Number) })
    expect(audit[0]!.before).toBeUndefined()
    expect(audit[1]).toMatchObject({ fields: ['notes'], before: { id: created.booking.id, notes: null } })
    expect(audit[3]!.booking_id).toBeNull()
  })
})

describe('privacy', () => {
  it('no guest data or tokens in the logs on any write path', async () => {
    const pii = {
      guest_name: 'Секретная Гостья',
      guest_phone: '+79990000777',
      guest_email: 'pii@example.com',
      notes: 'PII-SEED',
    }
    const { call, write, lines } = setup('full', { failNext: { method: 'PUT', with: 'timeout' } })
    const args = { ...ANNA, ...pii }
    const p = await call('preview_create_booking', args)
    await call('create_booking', { ...args, confirm_token: p.confirm_token }) // timeout
    const r = await call('create_booking', { ...args, confirm_token: p.confirm_token })
    await call('create_booking', { ...args, confirm_token: 'forged.token' }) // stale
    await call('preview_create_booking', { ...args, check_in: '2054-11-09', check_out: '2054-11-11' }) // will_fail
    await write('update_booking', { booking_id: r.booking.id, notes_append: 'PII-SEED-2' })
    await write('cancel_booking', { booking_id: r.booking.id })
    await write('delete_booking', { booking_id: r.booking.id })
    const log = lines.join('\n')
    for (const s of ['Секретная', '79990000777', 'pii@example.com', 'PII-SEED', p.confirm_token, 'test-token']) {
      expect(log).not.toContain(s)
    }
  })
})
