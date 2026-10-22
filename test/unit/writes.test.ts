import { describe, expect, it } from 'vitest'
import {
  appendNote,
  applyChanges,
  createBody,
  KNOWN_BOOKING_KEYS,
  putBodyFromGet,
  updatedAmount,
} from '../../src/domain/writes.js'
import { BookingRawSchema, type BookingRaw } from '../../src/upstream/schemas.js'
import { fixture } from '../fake-rc.js'

const BOOKINGS = ['booking_810000162', 'booking_810000173', 'booking_810000176']
const raw = (name: string): BookingRaw => BookingRawSchema.parse(fixture(name))

describe('putBodyFromGet', () => {
  it('fixtures have exactly the known keys', () => {
    for (const name of BOOKINGS)
      expect(Object.keys(fixture<object>(name)).sort()).toEqual([...KNOWN_BOOKING_KEYS].sort())
  })

  it.each(BOOKINGS)('no-op round trip of %s reproduces the GET', (name) => {
    const get = raw(name)
    const { event_calendar: ec, ...top } = putBodyFromGet(get)
    for (const k of [
      'apartment_id',
      'realty_room_id',
      'status',
      'begin_date',
      'end_date',
      'arrival_time',
      'departure_time',
      'amount',
      'notes',
      'color',
      'reaction',
      'source_id',
      'platform_tax',
    ] as const) {
      expect(ec[k], k).toEqual(get[k])
    }
    expect(ec.additional_services).toEqual(get.additional_services)
    expect(ec.guest).toEqual({
      id: get.guest!.id,
      fio: get.guest!.fio,
      email: get.guest!.email,
      phone: get.guest!.phone,
      additional_phone: get.guest!.additional_phone,
      attachments: [],
      destroy_attachments_ids: [],
    })
    expect(ec.client.id).toBe(get.client!.id)
    expect(ec.attachments).toEqual([])
    expect(top).toEqual({
      prepaid_amount: null,
      send_confirm_email: false,
      send_link_prepaid: false,
      lead_id: null,
      destroy_attachments_ids: [],
    })
  })

  it('an unknown GET key → RC_SCHEMA_DRIFT', () => {
    const get = { ...raw('booking_810000176'), loyalty_points: 5 }
    expect(() => putBodyFromGet(get)).toThrow(expect.objectContaining({ code: 'RC_SCHEMA_DRIFT' }))
  })

  it('no guest record → RC_SCHEMA_DRIFT (never creates a new guest)', () => {
    const get = { ...raw('booking_810000176'), guest: null }
    expect(() => putBodyFromGet(get)).toThrow(expect.objectContaining({ code: 'RC_SCHEMA_DRIFT' }))
  })
})

describe('applyChanges', () => {
  it('changes only the given fields', () => {
    const body = putBodyFromGet(raw('booking_810000162'))
    const changed = applyChanges(body, { status: 'canceled', realty_room_id: null, apartment_id: 810000051 })
    expect(changed.event_calendar).toEqual({
      ...body.event_calendar,
      status: 'canceled',
      realty_room_id: null,
      apartment_id: 810000051,
    })
    expect(body.event_calendar.status).toBe('booked') // not mutated
  })
})

describe('createBody', () => {
  it('has the shape the web form sends, guest and client without ids', () => {
    const body = createBody({
      apartment_id: 810000052,
      realty_room_id: 810000029,
      status: 'booked',
      begin_date: '2055-01-20',
      end_date: '2055-01-23',
      arrival_time: null,
      departure_time: null,
      amount: 33000,
      notes: null,
      source_id: null,
      guest: { fio: 'TEST MCP Иван', phone: '+79990000001', email: null },
    })
    expect(Object.keys(body.event_calendar).sort()).toEqual(
      [
        'apartment_id',
        'status',
        'realty_room_id',
        'begin_date',
        'end_date',
        'arrival_time',
        'departure_time',
        'amount',
        'platform_tax',
        'notes',
        'color',
        'reaction',
        'source_id',
        'guest',
        'client',
        'attachments',
        'additional_services',
      ].sort(),
    )
    expect(body.event_calendar.guest).toMatchObject({ id: null, fio: 'TEST MCP Иван', attachments: [] })
    expect(body.event_calendar.client).toEqual({
      id: null,
      fio: 'TEST MCP Иван',
      phone: '+79990000001',
      email: null,
      additional_phone: null,
    })
    expect(body.send_confirm_email).toBe(false)
    expect(body.send_link_prepaid).toBe(false)
  })
})

describe('price rules', () => {
  const base = { amount: 33000, oldNights: 3, newNights: 3, categoryChanged: false }
  it('a given price wins', () => {
    expect(updatedAmount({ ...base, newNights: 4, total: 40000 })).toEqual({ amount: 40000, rule: 'total' })
    expect(updatedAmount({ ...base, newNights: 4, perNight: 10000 })).toEqual({ amount: 40000, rule: 'per_night' })
  })
  it('changed nights keep the average per night', () => {
    expect(updatedAmount({ ...base, newNights: 2 })).toEqual({ amount: 22000, rule: 'kept_average' })
    expect(updatedAmount({ ...base, newNights: 4, categoryChanged: true }).rule).toBe('kept_average')
  })
  it('a category change on the same nights keeps the total', () => {
    expect(updatedAmount({ ...base, categoryChanged: true })).toEqual({ amount: 33000, rule: 'kept_total' })
    expect(updatedAmount(base)).toEqual({ amount: 33000, rule: 'unchanged' })
  })
})

describe('notes', () => {
  it('append keeps the old note', () => {
    expect(appendNote('Поздний заезд', 'Нужна детская кроватка')).toBe('Поздний заезд\nНужна детская кроватка')
    expect(appendNote(null, 'Нужна детская кроватка')).toBe('Нужна детская кроватка')
    expect(appendNote('', 'x')).toBe('x')
  })
})
