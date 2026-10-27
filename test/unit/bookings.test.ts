import { describe, expect, it } from 'vitest'
import { memoryCache } from '../../src/cache.js'
import { parseConfig } from '../../src/config.js'
import { makeContext } from '../../src/context.js'
import {
  auditTime,
  filterBookings,
  fromDetail,
  fromGrid,
  history,
  matchesQuery,
  totals,
} from '../../src/domain/bookings.js'
import { categoryById } from '../../src/domain/catalog.js'
import type { Booking, Grid, Payments } from '../../src/upstream/schemas.js'
import { fakeRc, fixture } from '../fake-rc.js'

async function setup() {
  const ctx = makeContext('t', parseConfig({}), memoryCache(), { fetch: fakeRc().fetch })
  const catalog = await ctx.catalog()
  return { catalog, list: fromGrid(catalog, fixture<Grid>('grid_booked_request')) }
}

describe('bookings from the grid', () => {
  it('builds summaries with money and booking-site flags', async () => {
    const { list } = await setup()
    expect(list).toHaveLength(54)
    for (const b of list) {
      expect(b.left).toBe(b.total - b.paid)
      expect(b.paid_in_full).toBe(b.paid >= b.total)
    }
    const ostrovok = list.find((b) => b.id === 810000162)!
    expect(ostrovok).toMatchObject({ source: 'Ostrovok.ru', from_booking_site: true, room: '25', unassigned: false })
    // Sutochno: is_external false in the grid, still a booking site (S1)
    expect(list.find((b) => b.id === 810000173)).toMatchObject({ source: 'Sutochno.ru', from_booking_site: true })
  })

  it('single-unit bookings are not unassigned', async () => {
    const { list } = await setup()
    const cottage = list.filter((b) => b.category_id === 810000055)
    expect(cottage.length).toBeGreaterThan(0)
    expect(cottage.every((b) => !b.unassigned && b.room === null)).toBe(true)
    expect(
      filterBookings(list, { unassignedOnly: true }).every((b) => b.room === null && b.category_id !== 810000055),
    ).toBe(true)
  })

  it('matches guests by name with endings and by phone digits', async () => {
    const { list } = await setup()
    const b = { ...list[0]!, guest_name: 'Анна Петрова', guest_phone: '+79161234567' }
    expect(matchesQuery(b, 'Петровой')).toBe(true)
    expect(matchesQuery(b, 'петров')).toBe(true)
    expect(matchesQuery(b, 'Иванова')).toBe(false)
    expect(matchesQuery(b, '916 123 45 67')).toBe(true)
    expect(matchesQuery(b, '8 (916) 123-45-67')).toBe(true)
    expect(matchesQuery(b, '9161234567')).toBe(true)
  })

  it('matches guest names across Cyrillic and Latin', async () => {
    const { list } = await setup()
    const as = (guest_name: string) => ({ ...list[0]!, guest_name })
    expect(matchesQuery(as('Igor Petrov'), 'Игорь')).toBe(true)
    expect(matchesQuery(as('Игорь Петров'), 'Igor')).toBe(true)
    expect(matchesQuery(as('Yulia Smirnova'), 'Юлия Смирновой')).toBe(true)
    expect(matchesQuery(as('Ksenia Orlova'), 'Ксения')).toBe(true)
    expect(matchesQuery(as('Igor Petrov'), 'Олег')).toBe(false)
  })

  it('sums totals', async () => {
    const { list } = await setup()
    const t = totals(list)
    expect(t.left).toBe(t.total - t.paid)
    expect(t.bookings).toBe(54)
  })
})

describe('booking detail', () => {
  it('builds the detail with payments and booking-site fields', async () => {
    const { catalog } = await setup()
    const d = fromDetail(catalog, fixture<Booking>('booking_810000162'), fixture<Payments>('payments_810000162'))
    expect(d).toMatchObject({
      id: 810000162,
      room: '25',
      total: 24000,
      paid: 24000,
      left: 0,
      paid_in_full: true,
      from_booking_site: true,
      created_at: '2054-10-01T09:00:00+03:00',
      deleted: false,
    })
    expect(d.booking_site!.platform).toBe('Ostrovok')
    expect(Object.keys(d.booking_site!.untrusted.fields)).toContain('Дата бронирования')
    expect(d.payments[0]).toMatchObject({ amount: 24000, type: 'income', account: 'Ostrovok' })
  })

  it('builds the change history from audits (shape seen live 2054-10-28)', async () => {
    const { catalog } = await setup()
    const b = fixture<Booking>('booking_810000176')
    const user = { full_name: 'Анна Петрова' }
    b.audits = [
      {
        version: 2,
        created_at: '2054-10-15 13:25:15 MSK',
        record: { title: 'Обновление Брони (810000176)' },
        is_auto: false,
        user,
        changes: [
          ['Выезд', ['2054-12-31', '2055-01-03']],
          ['Сумма', [0.0, 88000.0]],
          ['Гость', [null, 'Иван Иванов']],
          ['booking_amount', [0, 88000]],
          ['Лот', [810000050, 810000051]],
          'not a change',
        ],
      },
      {
        version: 1,
        created_at: '2054-10-15 13:21:49 MSK',
        record: { title: 'Создание Брони (810000176)' },
        is_auto: true,
        user,
        changes: [['Статус', ['', 'Бронь']]],
      },
      { version: 3, created_at: '2054-10-15 13:25:15 MSK', is_auto: false, user, changes: [['guest_id', [null, 1]]] },
    ]
    const h = history(catalog, b)
    expect(h.map((e) => e.time)).toEqual(['2054-10-15T13:21:49+03:00', '2054-10-15T13:25:15+03:00'])
    expect(h[0]).toMatchObject({ by: 'Анна Петрова', automatic: true, untrusted: { changes: [{ from: null }] } })
    expect(h[1]!.untrusted.changes).toEqual([
      { field: 'Выезд', from: '2054-12-31', to: '2055-01-03' },
      { field: 'Сумма', from: 0, to: 88000 },
      { field: 'Гость', from: null, to: 'Иван Иванов' },
      {
        field: 'Категория',
        from: categoryById(catalog, 810000050)!.title,
        to: categoryById(catalog, 810000051)!.title,
      },
    ])
  })

  it('converts audit times', () => {
    expect(auditTime('2054-10-01 09:00:00 MSK')).toBe('2054-10-01T09:00:00+03:00')
  })
})
