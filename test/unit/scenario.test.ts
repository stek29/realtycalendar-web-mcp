// The eval scenario meets each case's `needs` (test/evals/cases.json): the expected calls succeed on it.
import { describe, expect, it } from 'vitest'
import { memoryCache } from '../../src/cache.js'
import { parseConfig } from '../../src/config.js'
import { makeContext } from '../../src/context.js'
import { runTool, TOOLS } from '../../src/mcp/server.js'
import { INJECTION, scenarioState } from '../evals/scenario.js'
import { fakeRc } from '../fake-rc.js'

function setup(caseId = '') {
  const rc = fakeRc({ state: scenarioState(caseId) })
  const ctx = makeContext('t', parseConfig({ RC_ACCESS: 'full' }), memoryCache(), {
    fetch: rc.fetch,
    now: () => new Date('2054-10-22T09:00:00+03:00'),
  })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return async (name: string, args: Record<string, unknown>, ok = true): Promise<any> => {
    const res = await runTool(
      ctx,
      TOOLS.find((t) => t.name === name)!,
      args,
    )
    const body = JSON.parse((res.content[0] as { text: string }).text)
    expect(!res.isError, JSON.stringify(body)).toBe(ok)
    return body
  }
}
const SEARCH = { from: '2054-10-22', to: '2055-04-20' }
const previewOk = (p: { confirm_token?: string; will_fail?: boolean }) => {
  expect(p.will_fail).toBe(false)
  expect(p.confirm_token).toBeTruthy()
}

describe('eval scenario', () => {
  it('U5a/U5d/U6g: room 22 free 7–10 Nov', async () => {
    const call = setup()
    for (const check_out of ['2054-11-09', '2054-11-10']) {
      previewOk(
        await call('preview_create_booking', {
          room: '22',
          check_in: '2054-11-07',
          check_out,
          guest_name: 'Анна Петрова',
        }),
      )
    }
  })

  it('U5b: two categories match "двухместную улучшенную"; 02 can take a booking', async () => {
    const call = setup()
    const a = await call('check_availability', {
      check_in: '2054-11-07',
      check_out: '2054-11-09',
      category: 'двухместную улучшенную',
    })
    expect(a.matched_categories).toHaveLength(2)
    previewOk(
      await call('preview_create_booking', {
        category: '02',
        check_in: '2054-11-07',
        check_out: '2054-11-09',
        guest_name: 'Сидоров',
      }),
    )
  })

  it('U5c: cottage hold over New Year', async () => {
    const call = setup()
    previewOk(
      await call('preview_create_booking', {
        category: 'коттедж',
        check_in: '2054-12-31',
        check_out: '2055-01-03',
        status: 'request',
        guest_name: 'Смирнов',
      }),
    )
  })

  it('U6a: one booking in 22 on Fri–Sun, movable to Sat–Mon', async () => {
    const call = setup()
    const l = await call('list_bookings', { room: '22', from: '2054-10-21', to: '2054-10-27' })
    expect(l.bookings.map((b: { check_in: string }) => b.check_in)).toEqual(['2054-10-23'])
    previewOk(
      await call('preview_update_booking', {
        booking_id: l.bookings[0].id,
        check_in: '2054-10-24',
        check_out: '2054-10-26',
      }),
    )
  })

  it('U3c/U6b: exactly one Иванов, extendable by a night', async () => {
    const call = setup()
    const l = await call('list_bookings', { ...SEARCH, query: 'Иванов' })
    expect(l.bookings).toHaveLength(1)
    expect(l.bookings[0]).toMatchObject({ room: '5', check_out: '2054-10-24' })
    previewOk(await call('preview_update_booking', { booking_id: l.bookings[0].id, check_out: '2054-10-25' }))
  })

  it('U6e: exactly one upcoming Анна Петрова (the loose match also brings "Пётр …")', async () => {
    const call = setup()
    const l = await call('list_bookings', { ...SEARCH, query: 'Петрова' })
    expect(l.bookings.filter((b: { guest_name: string }) => b.guest_name === 'Анна Петрова')).toHaveLength(1)
  })

  it('810000208: partly paid, with a note; cancel, delete and notes previews work', async () => {
    const call = setup()
    expect(await call('get_booking', { booking_id: 810000208 })).toMatchObject({
      total: 30000,
      paid: 10000,
      untrusted: { notes: 'Поздний заезд' },
    })
    for (const [tool, args] of [
      ['preview_cancel_booking', {}],
      ['preview_delete_booking', {}],
      ['preview_update_booking', { notes_append: 'Нужна детская кроватка' }],
    ] as const) {
      expect((await call(tool, { booking_id: 810000208, ...args })).confirm_token).toBeTruthy()
    }
  })

  it('X6: the note is an injection', async () => {
    const call = setup('X6')
    expect((await call('get_booking', { booking_id: 810000208 })).untrusted.notes).toBe(INJECTION)
  })

  it('U9/U10b/U10c: the Ostrovok booking booked yesterday, unassigned over New Year, can go into 11, not 22', async () => {
    const call = setup()
    const l = await call('list_bookings', { from: '2054-12-31', to: '2055-01-01', source: 'островок' })
    expect(l.bookings.map((b: { id: number }) => b.id)).toContain(810000201)
    const d = await call('get_booking', { booking_id: 810000201 })
    expect(d.booking_site.untrusted.fields['Дата бронирования']).toBe('2054-10-21')
    previewOk(await call('preview_update_booking', { booking_id: 810000201, room: '11' }))
    expect((await call('preview_update_booking', { booking_id: 810000201, room: '22' }, false)).error).toBe(
      'SITE_BOOKING',
    )
  })

  it('U11/Q1: room 5 free 20–23 Jan at 33 000', async () => {
    const call = setup()
    const a = await call('check_availability', { check_in: '2055-01-20', check_out: '2055-01-23', room: '5' })
    expect(a.categories[0]).toMatchObject({ price_total: 33000 })
    expect(a.categories[0].rooms[0].bookable).toBe(true)
  })
})
