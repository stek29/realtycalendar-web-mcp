import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { RcClient, encodeQuery } from '../../src/upstream/client.js'
import type { ToolError } from '../../src/domain/errors.js'

type Handler = (url: URL, init: RequestInit) => Response | Promise<Response>

function client(handler: Handler, lines: string[] = []) {
  const calls: { url: URL; init: RequestInit }[] = []
  const fetch = (async (input: URL, init: RequestInit) => {
    calls.push({ url: input, init })
    return handler(input, init)
  }) as typeof globalThis.fetch
  const rc = new RcClient('tok123', {
    baseUrl: 'https://rc.test/v2/',
    fetch,
    retryDelayMs: () => 0,
    log: { log: (level, event, fields) => lines.push(JSON.stringify({ level, event, ...fields })) },
  })
  return { rc, calls }
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers })

async function errorOf(p: Promise<unknown>): Promise<ToolError> {
  try {
    await p
  } catch (e) {
    return e as ToolError
  }
  throw new Error('expected an error')
}

describe('encodeQuery', () => {
  it('encodes Rails arrays and skips empty values', () => {
    expect(encodeQuery({ statuses: ['booked', 'request'], apartment_ids: '1,2', x: undefined })).toBe(
      '?statuses%5B%5D=booked&statuses%5B%5D=request&apartment_ids=1%2C2',
    )
  })
})

describe('RcClient', () => {
  it('sends the auth headers and validates the response', async () => {
    const { rc, calls } = client(() => json(200, { a: 1 }))
    expect(await rc.get('info', {}, z.object({ a: z.number() }))).toEqual({ a: 1 })
    const headers = calls[0]!.init.headers as Record<string, string>
    expect(headers['X-User-Token']).toBe('tok123')
    expect(headers['X-Locale']).toBe('ru')
    expect(calls[0]!.url.href).toBe('https://rc.test/v2/info')
  })

  it('retries a GET once on 5xx', async () => {
    let n = 0
    const { rc } = client(() => (n++ === 0 ? json(502, {}) : json(200, { ok: true })))
    expect(await rc.get('info', {}, z.object({ ok: z.boolean() }))).toEqual({ ok: true })
    expect(n).toBe(2)
  })

  it('does not retry writes', async () => {
    let n = 0
    const { rc } = client(() => (n++, json(502, {})))
    expect((await errorOf(rc.send('PUT', 'event_calendars/1', {}, z.unknown()))).code).toBe('RC_ERROR')
    expect(n).toBe(1)
  })

  it('maps RC errors to tool error codes', async () => {
    const cases: [number, unknown, string][] = [
      [401, {}, 'AUTH'],
      [404, {}, 'NOT_FOUND'],
      [400, { error: 'date range' }, 'RANGE_TOO_LONG'],
      [422, { errors: { end_date: ['На данные числа объект занят'] } }, 'OCCUPIED'],
      [422, { errors: { realty_room_id: ['Комната не найдена'] } }, 'ROOM_NOT_IN_CATEGORY'],
      [422, { errors: { begin_date: ['Дата заезда не может быть больше даты выезда'] } }, 'INVALID_DATES'],
      [
        422,
        { errors: ["The property '#/event_calendar' did not contain a required property of 'status'"] },
        'VALIDATION',
      ],
    ]
    for (const [status, body, code] of cases) {
      const { rc } = client(() => json(status, body))
      expect((await errorOf(rc.send('PUT', 'x', {}, z.unknown()))).code).toBe(code)
    }
  })

  it('reports schema drift without leaking values', async () => {
    const lines: string[] = []
    const { rc } = client(() => json(200, { amount: 'Иван Петров +79161234567' }), lines)
    const err = await errorOf(rc.get('event_calendars/1', {}, z.object({ amount: z.number() })))
    expect(err.code).toBe('RC_SCHEMA_DRIFT')
    expect(lines.join('\n')).not.toMatch(/Петров|79161234567|tok123/)
  })

  it('redacts 422 field values', async () => {
    const { rc } = client(() => json(422, { errors: { phone: ['+7 916 123-45-67 неверный'] } }))
    const err = await errorOf(rc.send('PUT', 'x', {}, z.unknown()))
    expect(JSON.stringify(err.toJSON())).not.toMatch(/916/)
  })

  it('follows X-Next-Cursor', async () => {
    const { rc, calls } = client((url) =>
      url.searchParams.get('cursor') ? json(200, [2]) : json(200, [1], { 'X-Has-More': 'true', 'X-Next-Cursor': 'c1' }),
    )
    expect(await rc.getPaged('arrivals_departures/by_dates', { limit: 50 }, z.array(z.number()))).toEqual([1, 2])
    expect(calls[1]!.url.searchParams.get('cursor')).toBe('c1')
  })
})
