// The write tools against the fake RC, following the spec §3 write stories (today = Thu 2054-10-22).
import { describe, expect, it } from 'vitest'
import { memoryCache } from '../../src/cache.js'
import { parseConfig, type Access } from '../../src/config.js'
import { makeContext } from '../../src/context.js'
import { createMcpServer, runTool, TOOLS } from '../../src/mcp/server.js'
import { fakeRc, type FakeRcOptions } from '../fake-rc.js'

const NOW = new Date('2054-10-22T09:00:00+03:00')

function setup(access: Access = 'full', opts: FakeRcOptions = {}) {
  const rc = fakeRc(opts)
  const lines: string[] = []
  const ctx = makeContext('test-token', parseConfig({ RC_ACCESS: access, RC_CONFIRM_KEY: 'k' }), memoryCache(), {
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
  /** Preview, then confirm with the preview's token. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const write = async (name: string, args: Record<string, unknown>): Promise<any> => {
    const preview = await call(name, args)
    expect(preview.confirm_token, JSON.stringify(preview)).toBeTruthy()
    return call(name, { ...args, confirm_token: preview.confirm_token })
  }
  const writes = () => rc.calls.filter((c) => !c.startsWith('GET') && !c.includes('group_special_prices'))
  return { call, write, writes, rc, lines, ctx }
}

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
    ['book', ['check_availability', 'create_booking', 'get_booking', 'list_bookings', 'list_rooms']],
    [
      'edit',
      [
        'cancel_booking',
        'check_availability',
        'create_booking',
        'get_booking',
        'list_bookings',
        'list_rooms',
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
    expect(await call('create_booking', ANNA)).toMatchObject({ isError: true, error: 'ACCESS_DENIED' })
    expect(writes()).toEqual([])
  })

  it('X7: cancel at book → ACCESS_DENIED', async () => {
    const { call } = setup('book')
    expect(await call('cancel_booking', { booking_id: 810000162 })).toMatchObject({ error: 'ACCESS_DENIED' })
  })
})

describe('create_booking', () => {
  it('U5a: preview changes nothing; confirm creates the booking', async () => {
    const { call, writes } = setup()
    const preview = await call('create_booking', ANNA)
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
    const amb = await call('create_booking', args)
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
    const [pa, pb] = [await call('create_booking', a), await call('create_booking', b)]
    const ra = await call('create_booking', { ...a, confirm_token: pa.confirm_token })
    const rb = await call('create_booking', { ...b, confirm_token: pb.confirm_token })
    expect([ra.booking.room, rb.booking.room]).toEqual(['22', '21'])
    expect(ra.booking.id).not.toBe(rb.booking.id)
  })

  it('U11: price per night → total; NO_GUEST_MESSAGES', async () => {
    const { call } = setup()
    const p = await call('create_booking', {
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
    const again = await call('create_booking', ANNA)
    expect(again.confirm_token).toBeUndefined()
    expect(codes(again)).toContain('DUPLICATE')
    expect(again.warnings[0].booking.id).toBe(first.booking.id)
    expect(writes()).toHaveLength(n)
  })

  it('an overlapping booked stay → will_fail, conflicts, no token', async () => {
    const { call, write } = setup()
    const first = await write('create_booking', ANNA)
    const p = await call('create_booking', {
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
    const p = await call('create_booking', { ...args, check_in: '2055-01-21', guest_name: 'TEST MCP Два' })
    expect(p.will_fail).toBe(true)
  })

  it('a hold over a booked stay: allowed, HOLD_OVERLAP on the next booking', async () => {
    const { call, write } = setup()
    await write('create_booking', { ...ANNA, status: 'request', guest_name: 'Заявка Тест' })
    const p = await call('create_booking', ANNA)
    expect(p.will_fail).toBe(false)
    expect(codes(p)).toContain('HOLD_OVERLAP')
  })

  it('L4: room taken between preview and confirm → OCCUPIED, nothing saved, conflicts', async () => {
    const { call, write } = setup()
    const p = await call('create_booking', ANNA)
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
      const p = await call('create_booking', ANNA)
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

  it('PUT 500 → RC_ERROR with the repeat hint', async () => {
    const { call } = setup('full', { failNext: { method: 'PUT', with: 500 } })
    const p = await call('create_booking', ANNA)
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
    expect(await call('create_booking', args)).toMatchObject({ isError: true, error })
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
    const blocked = await call('update_booking', { booking_id: id, check_in: '2054-11-09', check_out: '2054-11-11' })
    expect(blocked).toMatchObject({ preview: true, will_fail: true })
    expect(blocked.confirm_token).toBeUndefined()

    const moved = await write('update_booking', { booking_id: id, check_in: '2054-11-11', check_out: '2054-11-13' })
    expect(moved.booking).toMatchObject({ check_in: '2054-11-11', check_out: '2054-11-13', total: 20000 })
  })

  it('U6b: extend → PRICE_CHANGED with old and new totals and the quote', async () => {
    const { call, id } = await booked()
    const p = await call('update_booking', { booking_id: id, check_out: '2054-11-13' })
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
    const p = await call('update_booking', { booking_id: id, check_out: '2054-11-13' })
    const n = writes().length
    const r = await call('update_booking', { booking_id: id, check_out: '2054-11-14', confirm_token: p.confirm_token })
    expect(r).toMatchObject({ isError: true, error: 'PREVIEW_STALE', preview: { after: { check_out: '2054-11-14' } } })
    expect(writes()).toHaveLength(n)
  })

  it('the booking changed between preview and confirm → PREVIEW_STALE', async () => {
    const { call, write, id } = await booked()
    const p = await call('update_booking', { booking_id: id, check_out: '2054-11-13' })
    await write('update_booking', { booking_id: id, arrival_time: '15:00' })
    const r = await call('update_booking', { booking_id: id, check_out: '2054-11-13', confirm_token: p.confirm_token })
    expect(r).toMatchObject({ error: 'PREVIEW_STALE' })
  })

  it('two confirms of one token at once: one PUT (confirms on a booking are serialised)', async () => {
    const { call, id, writes } = await booked()
    const args = { booking_id: id, check_out: '2054-11-13', confirm_token: '' }
    args.confirm_token = (await call('update_booking', { ...args, confirm_token: undefined })).confirm_token
    const n = writes().length
    const [a, b] = await Promise.all([call('update_booking', args), call('update_booking', args)])
    expect(a.preview).toBe(false)
    expect(b.isError).toBe(true) // the second sees the saved change: nothing left to do
    expect(writes()).toHaveLength(n + 1)
  })

  it('U10b: room in another category → CATEGORY_CHANGE, PRICE_KEPT; apartment follows the room', async () => {
    const { call, write } = setup()
    const p = await call('update_booking', { booking_id: 810000176, room: '23' })
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

  it('BOOKING_SITE on a booking-site booking', async () => {
    const { call } = setup()
    const p = await call('update_booking', { booking_id: 810000162, check_out: '2055-01-09' })
    expect(codes(p)).toContain('BOOKING_SITE')
    const notes = await call('update_booking', { booking_id: 810000162, notes_append: 'x' })
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
    expect(await call('update_booking', { booking_id: 810000162, ...changes })).toMatchObject({ isError: true, error })
  })

  it('nothing would change → VALIDATION', async () => {
    const { call } = setup()
    expect(await call('update_booking', { booking_id: 810000162, check_in: '2054-12-20' })).toMatchObject({
      error: 'VALIDATION',
    })
  })

  it('unknown id → NOT_FOUND', async () => {
    const { call } = setup()
    expect(await call('update_booking', { booking_id: 1, notes_append: 'x' })).toMatchObject({ error: 'NOT_FOUND' })
  })
})

describe('cancel_booking and delete_booking', () => {
  it('U6c: cancel a booking-site booking with payments', async () => {
    const { call, write } = setup()
    const p = await call('cancel_booking', { booking_id: 810000162 })
    expect(codes(p)).toEqual(expect.arrayContaining(['BOOKING_SITE', 'HAS_PAYMENTS']))
    expect(p.summary).toMatch(/^Отменить бронь 810000162: 25,/)
    const r = await write('cancel_booking', { booking_id: 810000162 })
    expect(r.booking.status).toBe('canceled')
    expect(await call('cancel_booking', { booking_id: 810000162 })).toMatchObject({ error: 'VALIDATION' })
    const avail = await call('check_availability', { check_in: '2055-01-02', check_out: '2055-01-08', room: '25' })
    expect(avail.categories[0].rooms[0].runs.every((r: { state: string }) => r.state !== 'booked')).toBe(true)
  })

  it('U6d: delete; then update and delete again → DELETED', async () => {
    const { call, write } = setup()
    const r = await write('delete_booking', { booking_id: 810000162 })
    expect(r).toMatchObject({ preview: false, deleted: true })
    expect(await call('update_booking', { booking_id: 810000162, notes_append: 'x' })).toMatchObject({
      error: 'DELETED',
    })
    expect(await call('delete_booking', { booking_id: 810000162 })).toMatchObject({ error: 'DELETED' })
  })

  it('deleted between preview and confirm → DELETED', async () => {
    const { call, write } = setup()
    const p = await call('cancel_booking', { booking_id: 810000176 })
    await write('delete_booking', { booking_id: 810000176 })
    expect(await call('cancel_booking', { booking_id: 810000176, confirm_token: p.confirm_token })).toMatchObject({
      error: 'DELETED',
    })
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
    const p = await call('create_booking', args)
    await call('create_booking', { ...args, confirm_token: p.confirm_token }) // timeout
    const r = await call('create_booking', { ...args, confirm_token: p.confirm_token })
    await call('create_booking', { ...args, confirm_token: 'forged.token' }) // stale
    await call('create_booking', { ...args, check_in: '2054-11-09', check_out: '2054-11-11' }) // will_fail
    await write('update_booking', { booking_id: r.booking.id, notes_append: 'PII-SEED-2' })
    await write('cancel_booking', { booking_id: r.booking.id })
    await write('delete_booking', { booking_id: r.booking.id })
    const log = lines.join('\n')
    for (const s of ['Секретная', '79990000777', 'pii@example.com', 'PII-SEED', p.confirm_token, 'test-token']) {
      expect(log).not.toContain(s)
    }
  })
})
