// In-memory RC built from the scrubbed fixtures: unit tests, evals, Inspector demos.
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Grid, GridEvent, StayRules } from '../src/upstream/schemas.js'

const DIR = join(import.meta.dirname, 'fixtures')
const fixtures = new Map(
  readdirSync(DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => [f.replace(/\.json$/, ''), JSON.parse(readFileSync(join(DIR, f), 'utf8')) as unknown]),
)
export const fixture = <T = unknown>(name: string): T => structuredClone(fixtures.get(name)) as T

/** A booking to add to the grid, e.g. a hold; fields default to an empty booked stay. */
export interface ExtraEvent extends Partial<GridEvent> {
  apartment_id: number
  room_id: number | null
  begin_date: string
  end_date: string
}

export interface FakeRc {
  fetch: typeof fetch
  /** "METHOD path?query" of every request, in order. */
  calls: string[]
}

let nextId = 900_000_000

export function fakeRc(opts: { extraEvents?: ExtraEvent[] } = {}): FakeRc {
  const calls: string[] = []
  const grid: Grid = {
    items: fixture<Grid>('grid_booked_request').items.map((item) => ({
      ...item,
      events: [...item.events, ...fixture<Grid>('grid_canceled').items.find((c) => sameRow(c, item))!.events],
    })),
  }
  for (const e of opts.extraEvents ?? []) {
    const row = grid.items.find((i) => sameRow(i, e))
    if (!row) throw new Error(`fake RC: no grid row for ${e.apartment_id}/${e.room_id}`)
    const { apartment_id, room_id, ...event } = e
    row.events.push({ ...blankEvent(), ...event })
  }
  const stayRules = fixture<StayRules>('stay_rules')

  const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : input)
    const method = init?.method ?? 'GET'
    const path = url.pathname.replace(/^\/v2\//, '')
    calls.push(`${method} ${path}${url.search}`)
    const q = url.searchParams
    let m: RegExpMatchArray | null

    if (method === 'GET' && path === 'info') return json(fixture('info'))
    if (method === 'GET' && path === 'apartments') return json(fixture('apartments'))
    if (method === 'GET' && (m = path.match(/^apartments\/(\d+)\/apartment_info$/))) {
      return fixtures.has(`apartment_info_${m[1]}`) ? json(fixture(`apartment_info_${m[1]}`)) : json({}, 404)
    }
    if (method === 'GET' && (m = path.match(/^apartments\/(\d+)\/price$/))) {
      const days = stayRules.apartments.find((a) => a.id === Number(m![1]))?.prices ?? []
      const begin = q.get('begin_date')!
      const end = q.get('end_date')!
      const price = days.filter((d) => d.date >= begin && d.date < end).reduce((s, d) => s + amount(d), 0)
      return json({ price })
    }
    if (method === 'GET' && path === 'event_calendars/') {
      const begin = q.get('begin_date')!
      const end = q.get('end_date')!
      if (Date.parse(end) - Date.parse(begin) > 365 * 86_400_000) return json({ error: 'date range' }, 400)
      const ids = new Set(q.get('apartment_ids')!.split(',').map(Number))
      const statuses = new Set(q.getAll('statuses[]'))
      const overlaps = (x: { begin_date: string; end_date: string }) => x.begin_date <= end && x.end_date > begin
      return json({
        items: grid.items
          .filter((i) => ids.has(i.apartment_id))
          .map((i) => ({
            ...i,
            events: i.events.filter((e) => statuses.has(e.status) && !e.is_delete && overlaps(e)),
            special_prices: i.special_prices.filter(overlaps),
          })),
      })
    }
    if (method === 'POST' && path === 'events/group_special_prices/prices') {
      const body = JSON.parse(String(init?.body)) as { apartment_ids: number[]; begin_date: string; end_date: string }
      return json({
        apartments: stayRules.apartments
          .filter((a) => body.apartment_ids.includes(a.id))
          .map((a) => ({ ...a, prices: a.prices.filter((d) => d.date >= body.begin_date && d.date <= body.end_date) })),
      })
    }
    if (method === 'GET' && (m = path.match(/^event_calendars\/(\d+)$/))) {
      return fixtures.has(`booking_${m[1]}`) ? json(fixture(`booking_${m[1]}`)) : json({}, 404)
    }
    if (method === 'GET' && (m = path.match(/^event_calendars\/(\d+)\/payments$/))) {
      return json(fixtures.has(`payments_${m[1]}`) ? fixture(`payments_${m[1]}`) : { data: [] })
    }
    return json({ error: `fake RC: no route for ${method} ${path}` }, 404)
  }
  return { fetch: fetch as typeof globalThis.fetch, calls }
}

const sameRow = (
  a: { apartment_id: number; room_id: number | null },
  b: { apartment_id: number; room_id: number | null },
) => a.apartment_id === b.apartment_id && a.room_id === b.room_id

const amount = (d: StayRules['apartments'][number]['prices'][number]) =>
  ((d as unknown as { amount?: { actual?: number | null } }).amount?.actual ?? 0) as number

function blankEvent(): GridEvent {
  return {
    id: nextId++,
    status: 'booked',
    begin_date: '',
    end_date: '',
    amount: 0,
    prepayment: 0,
    is_external: false,
    is_delete: false,
    source_id: null,
    arrival_time: null,
    departure_time: null,
    client: { fio: 'Иван Иванов', phone: null },
    client_notes: '',
    updated_at: '2054-10-22T12:00:00.000+03:00',
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}
