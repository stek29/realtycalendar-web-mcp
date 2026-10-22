// In-memory RC built from the scrubbed fixtures: unit tests, evals, Inspector demos. Writes behave as RC did in the
// live tests (mcp-user-stories.md "Write API", "Write baseline"): drafts, strict PUT bodies, occupancy, soft delete.
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { OWN_SOURCES } from '../src/domain/catalog.js'
import { canonicalJson } from '../src/domain/confirm.js'
import type { Apartments, Grid, GridEvent, StayRules } from '../src/upstream/schemas.js'

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

/** A booking detail in the GET shape (the 36 keys). */
export type Detail = Record<string, unknown> & {
  id: number
  status: string
  apartment_id: number
  realty_room_id: number | null
  begin_date: string
  end_date: string
  is_delete: boolean
}

/** Everything the fake knows; plain JSON, so evals can keep it in a file between turns. */
export interface FakeState {
  nextId: number
  /** Seconds added to the base time for each write's updated_at. */
  clock: number
  /** Every booking, canceled and deleted ones included (the grid GET filters). */
  grid: Grid
  /** Details of bookings that were read or written (others are built from fixtures or the grid on demand). */
  details: Record<string, Detail>
  drafts: Record<
    string,
    { status: string; apartment_id: number; realty_room_id: number | null; begin_date: string; end_date: string }
  >
}

export interface FakeRcOptions {
  extraEvents?: ExtraEvent[]
  /** Start from this state instead of the fixtures (mutated in place). */
  state?: FakeState
  /** The next request with this method fails: timeout or 500; `saved` = RC applied it before failing. */
  failNext?: { method: 'POST' | 'PUT' | 'DELETE'; with: 'timeout' | 500; saved?: boolean }
}

export interface FakeRc {
  fetch: typeof fetch
  /** "METHOD path?query" of every request, in order. */
  calls: string[]
  state: FakeState
}

const BASE_TIME = Date.parse('2054-10-22T12:00:00+03:00')

/** Keys a PUT body must have (RC's strict schema). */
const EVENT_KEYS = [
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
]
const TOP_KEYS = ['prepaid_amount', 'send_confirm_email', 'send_link_prepaid', 'lead_id', 'destroy_attachments_ids']

export function initialState(extraEvents: ExtraEvent[] = []): FakeState {
  const grid: Grid = {
    items: fixture<Grid>('grid_booked_request').items.map((item) => ({
      ...item,
      events: [...item.events, ...fixture<Grid>('grid_canceled').items.find((c) => sameRow(c, item))!.events],
    })),
  }
  const state: FakeState = { nextId: 900_000_000, clock: 0, grid, details: {}, drafts: {} }
  for (const e of extraEvents) {
    const { apartment_id, room_id, ...event } = e
    rowOf(state, { apartment_id, room_id }).events.push({ ...blankEvent(state), ...event })
  }
  return state
}

export function fakeRc(opts: FakeRcOptions = {}): FakeRc {
  const calls: string[] = []
  const state = opts.state ?? initialState(opts.extraEvents)
  let failNext = opts.failNext
  const stayRules = fixture<StayRules>('stay_rules')
  const apartments = fixture<Apartments>('apartments')
  const capacity = (apartmentId: number) =>
    Math.max(1, apartments.apartments.find((a) => a.id === apartmentId)?.rooms.filter((r) => r.id !== 0).length ?? 1)
  const categoryOfRoom = (roomId: number) => apartments.apartments.find((a) => a.rooms.some((r) => r.id === roomId))
  const tick = () => new Date(BASE_TIME + ++state.clock * 1000).toISOString().replace('Z', '+00:00')

  const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : input)
    const method = init?.method ?? 'GET'
    const path = url.pathname.replace(/^\/v2\//, '')
    calls.push(`${method} ${path}${url.search}`)
    const q = url.searchParams
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined
    let m: RegExpMatchArray | null

    let failure: FakeRcOptions['failNext']
    if (failNext && failNext.method === method) [failure, failNext] = [failNext, undefined]
    const fail = () => {
      if (failure!.with === 'timeout') throw new DOMException('The operation timed out.', 'TimeoutError')
      return json({ error: 'Internal Server Error' }, 500)
    }
    if (failure && !failure.saved) return fail()
    const respond = (res: Response) => (failure ? fail() : res)

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
        items: state.grid.items
          .filter((i) => ids.has(i.apartment_id))
          .map((i) => ({
            ...i,
            events: i.events.filter((e) => statuses.has(e.status) && !e.is_delete && overlaps(e)),
            special_prices: i.special_prices.filter(overlaps),
          })),
      })
    }
    if (method === 'POST' && path === 'events/group_special_prices/prices') {
      const b = body as { apartment_ids: number[]; begin_date: string; end_date: string }
      return json({
        apartments: stayRules.apartments
          .filter((a) => b.apartment_ids.includes(a.id))
          .map((a) => ({ ...a, prices: a.prices.filter((d) => d.date >= b.begin_date && d.date <= b.end_date) })),
      })
    }
    if (method === 'GET' && (m = path.match(/^event_calendars\/(\d+)$/))) {
      const detail = detailOf(state, Number(m[1]))
      return detail ? json(detail) : json({ error: 'not found' }, 404)
    }
    if (method === 'GET' && (m = path.match(/^event_calendars\/(\d+)\/payments$/))) {
      return json(paymentsOf(state, Number(m[1])))
    }

    // Writes.
    if (method === 'POST' && path === 'event_calendars') {
      // A draft: no availability check, invisible until its PUT.
      const d = (body as { event_calendar: FakeState['drafts'][string] }).event_calendar
      const id = state.nextId++
      state.drafts[id] = { ...d }
      return respond(json({ id, ...d, amount: 0, guest: null, client: null, preparing: true }))
    }
    if (method === 'PUT' && (m = path.match(/^event_calendars\/(\d+)$/))) {
      const id = Number(m[1])
      const draft = state.drafts[id]
      const current = draft ? undefined : detailOf(state, id)
      if (!draft && !current) return json({ error: 'not found' }, 404)
      const ec = (body?.event_calendar ?? {}) as Record<string, unknown>
      const missing = [
        ...EVENT_KEYS.filter((k) => !(k in ec)).map((k) => ['#/event_calendar', k]),
        ...TOP_KEYS.filter((k) => !(k in (body ?? {}))).map((k) => ['#/', k]),
      ]
      if (missing.length) {
        return json(
          { errors: missing.map(([at, k]) => `The property '${at}' did not contain a required property of '${k}'`) },
          422,
        )
      }
      const f = ec as {
        apartment_id: number
        realty_room_id: number | null
        status: string
        begin_date: string
        end_date: string
        guest: { id: number | null; fio: string | null; phone: string | null; email: string | null }
        client: { id: number | null }
      }
      if (f.begin_date >= f.end_date) {
        return json({ errors: { begin_date: ['Дата заезда не может быть больше даты выезда'] } }, 422)
      }
      let roomId = f.realty_room_id
      const before = (draft ?? current)!
      if (roomId != null && categoryOfRoom(roomId)?.id !== f.apartment_id) {
        if (f.apartment_id === before.apartment_id) {
          return json({ errors: { realty_room_id: ['Комната не найдена'] } }, 422)
        }
        roomId = null // category changed, room from elsewhere: RC drops the room silently
      }
      if (f.status === 'booked' && occupied(state, id, f.apartment_id, roomId, f.begin_date, f.end_date, capacity)) {
        return json({ errors: { end_date: ['На данные числа объект занят'] } }, 422)
      }
      const detail = saveDetail(state, id, current, { ...ec, realty_room_id: roomId }, tick())
      delete state.drafts[id]
      return respond(json(detail))
    }
    if (method === 'DELETE' && (m = path.match(/^event_calendars\/(\d+)$/))) {
      const id = Number(m[1])
      const detail = state.drafts[id] ? undefined : detailOf(state, id)
      if (!detail) return json({ error: 'not found' }, 404)
      detail.is_delete = true
      detail.updated_at = tick()
      const found = findEvent(state, id)
      if (found) Object.assign(found.event, { is_delete: true, updated_at: detail.updated_at })
      return respond(json(detail))
    }
    return json({ error: `fake RC: no route for ${method} ${path}` }, 404)
  }
  return { fetch: fetch as typeof globalThis.fetch, calls, state }
}

type Row = Grid['items'][number]

const sameRow = (
  a: { apartment_id: number; room_id: number | null },
  b: { apartment_id: number; room_id: number | null },
) => a.apartment_id === b.apartment_id && a.room_id === b.room_id

function rowOf(state: FakeState, r: { apartment_id: number; room_id: number | null }): Row {
  let row = state.grid.items.find((i) => sameRow(i, r))
  if (!row) state.grid.items.push((row = { ...r, events: [], special_prices: [] }))
  return row
}

function findEvent(state: FakeState, id: number): { row: Row; event: GridEvent } | undefined {
  for (const row of state.grid.items) {
    const event = row.events.find((e) => e.id === id)
    if (event) return { row, event }
  }
  return undefined
}

/** RC's rule: per room one booked stay; per category assigned + unassigned booked ≤ rooms (1 for a single unit). */
function occupied(
  state: FakeState,
  selfId: number,
  apartmentId: number,
  roomId: number | null,
  begin: string,
  end: string,
  capacity: (apartmentId: number) => number,
): boolean {
  const booked = state.grid.items
    .filter((r) => r.apartment_id === apartmentId)
    .flatMap((row) =>
      row.events.filter((e) => e.id !== selfId && !e.is_delete && e.status === 'booked').map((e) => ({ row, e })),
    )
  for (let night = begin; night < end; night = nextDay(night)) {
    const on = booked.filter(({ e }) => e.begin_date <= night && night < e.end_date)
    if (roomId != null && on.some(({ row }) => row.room_id === roomId)) return true
    if (on.length + 1 > capacity(apartmentId)) return true
  }
  return false
}

const nextDay = (d: string) => new Date(Date.parse(`${d}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10)

/** Like RC (spec §5 S1): a booking from a site has platform_name even when the grid's is_external is false. */
function siteSource(id: number | null): string | null {
  const sources = fixture<{ agency: { sources_list: { id: number; title: string }[] } }>('info').agency.sources_list
  const title = sources.find((s) => s.id === id)?.title
  return title && !OWN_SOURCES.has(title) ? title : null
}

/** The booking's detail: written before, a fixture, or built from its grid event. Drafts and unknown ids: none. */
export function detailOf(state: FakeState, id: number): Detail | undefined {
  if (state.drafts[id]) return undefined
  if (state.details[id]) return state.details[id]
  if (fixtures.has(`booking_${id}`)) return (state.details[id] = fixture<Detail>(`booking_${id}`))
  const found = findEvent(state, id)
  if (!found) return undefined
  const { row, event: e } = found
  const person = {
    id: id + 1,
    fio: e.client?.fio ?? null,
    phone: e.client?.phone ?? null,
    email: null,
    additional_phone: null,
  }
  return (state.details[id] = {
    id,
    begin_date: e.begin_date,
    end_date: e.end_date,
    status: e.status,
    apartment_id: row.apartment_id,
    realty_room_id: row.room_id,
    is_delete: e.is_delete,
    updated_at: e.updated_at,
    automessages_enabled: false,
    additional_services: { early_checkin: null, late_checkout: null },
    platform_tax: null,
    realty_room_title: null,
    booking_started: false,
    booking_finished: false,
    prepaid_amount: 0,
    notes: e.short_notes || null,
    preparing: false,
    is_external: e.is_external,
    color: null,
    reaction: null,
    arrival_time: e.arrival_time,
    departure_time: e.departure_time,
    send_link_prepaid: false,
    send_confirm_email: false,
    attachments: [],
    default_prepayment_amount: 0,
    default_deposit_amount: 0,
    amount: e.amount,
    deposit_refund_available_amount: 0,
    client: person,
    source_id: e.source_id,
    guest: { ...person, id: id + 2, notes: null, attachments: [] },
    oki_doki_contract: null,
    external: null,
    platform_name: e.is_external ? 'Booking site' : siteSource(e.source_id),
    audits: [
      { version: 1, created_at: '2054-10-01 12:00:00 MSK', record: { title: `Создание Брони (${id})` }, changes: [] },
    ],
  })
}

/** Applies a PUT body: the detail as RC returns it, and the grid event moved to its row. */
function saveDetail(
  state: FakeState,
  id: number,
  current: Detail | undefined,
  ec: Record<string, unknown>,
  now: string,
): Detail {
  const newId = () => state.nextId++
  const g = ec.guest as Record<string, unknown>
  const c = ec.client as Record<string, unknown>
  const contact = (p: Record<string, unknown>) => ({
    fio: p.fio,
    phone: p.phone,
    email: p.email,
    additional_phone: p.additional_phone,
  })
  const comparable = (d: Detail) => canonicalJson({ ...d, updated_at: null })
  const detail: Detail = {
    ...(current ?? (detailTemplate(id) as Detail)),
    apartment_id: ec.apartment_id as number,
    realty_room_id: ec.realty_room_id as number | null,
    status: ec.status as string,
    begin_date: ec.begin_date as string,
    end_date: ec.end_date as string,
    arrival_time: ec.arrival_time,
    departure_time: ec.departure_time,
    amount: ec.amount,
    platform_tax: ec.platform_tax,
    notes: ec.notes,
    color: ec.color,
    reaction: ec.reaction,
    source_id: ec.source_id,
    additional_services: ec.additional_services,
    // guest.id null → RC creates a new guest record (and client), every time.
    guest: { ...((current?.guest as object) ?? { notes: null, attachments: [] }), id: g.id ?? newId(), ...contact(g) },
    client: { id: c.id ?? newId(), ...contact(c) },
    preparing: false,
  }
  const changed = !current || comparable(detail) !== comparable(current)
  detail.updated_at = now
  if (changed) {
    const audits = (current?.audits as { version: number }[] | undefined) ?? []
    detail.audits = [
      ...audits,
      {
        version: audits.length + 1,
        created_at: '2054-10-22 12:00:00 MSK',
        record: { title: `${current ? 'Обновление' : 'Создание'} Брони (${id})` },
        changes: [],
      },
    ]
  }
  state.details[id] = detail

  const found = findEvent(state, id)
  if (found) found.row.events.splice(found.row.events.indexOf(found.event), 1)
  rowOf(state, { apartment_id: detail.apartment_id, room_id: detail.realty_room_id }).events.push({
    ...(found?.event ?? blankEvent(state)),
    id,
    status: detail.status,
    begin_date: detail.begin_date,
    end_date: detail.end_date,
    amount: detail.amount as number,
    is_delete: detail.is_delete,
    source_id: detail.source_id as number | null,
    arrival_time: detail.arrival_time as string | null,
    departure_time: detail.departure_time as string | null,
    client: { fio: (c.fio as string | null) ?? null, phone: (c.phone as string | null) ?? null },
    short_notes: (detail.notes as string | null) ?? '',
    updated_at: now,
  })
  return detail
}

/** A new booking's detail before its first PUT fills it in. */
function detailTemplate(id: number): Record<string, unknown> {
  return {
    id,
    is_delete: false,
    automessages_enabled: false,
    realty_room_title: null,
    booking_started: false,
    booking_finished: false,
    prepaid_amount: 0,
    is_external: false,
    send_link_prepaid: false,
    send_confirm_email: false,
    attachments: [],
    default_prepayment_amount: 0,
    default_deposit_amount: 0,
    deposit_refund_available_amount: 0,
    oki_doki_contract: null,
    external: null,
    platform_name: null,
    audits: [],
  }
}

/** Fixture payments, or one manual payment for a grid booking with a prepayment. */
function paymentsOf(state: FakeState, id: number): unknown {
  if (fixtures.has(`payments_${id}`)) return fixture(`payments_${id}`)
  const prepayment = findEvent(state, id)?.event.prepayment ?? 0
  if (!prepayment) return { data: [] }
  return {
    data: [
      {
        id: id + 3,
        created_at: '2054-10-20T12:00:00.000+03:00',
        note: null,
        status: { text: 'Оплачено вручную' },
        payment: { type: 'income', amount: prepayment },
        invoice: { id: 1, title: 'Наличные' },
      },
    ],
  }
}

const amount = (d: StayRules['apartments'][number]['prices'][number]) =>
  ((d as unknown as { amount?: { actual?: number | null } }).amount?.actual ?? 0) as number

function blankEvent(state: FakeState): GridEvent {
  return {
    id: state.nextId++,
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
    short_notes: '',
    updated_at: '2054-10-22T12:00:00.000+03:00',
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

export interface SignInRc {
  fetch: typeof fetch
  /** RC tokens that still work; clear it to end every session. */
  live: Set<string>
  /** Usernames of every sign-in attempt. */
  signIns: string[]
  /** Headers of every request, in order. */
  headers: Headers[]
  setPassword(password: string): void
}

/** The fake RC behind a sign-in: POST sign_in issues tokens for one user, any other call needs a live token. */
export function signInRc(user: { username: string; password: string }, rc: FakeRc = fakeRc()): SignInRc {
  const live = new Set<string>()
  const signIns: string[] = []
  const seen: Headers[] = []
  let password = user.password
  let n = 0
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input)
    seen.push(new Headers(init?.headers))
    if (url.pathname === '/v2/sign_in' && init?.method === 'POST') {
      const body = JSON.parse(String(init.body)) as { username: string; password: string }
      signIns.push(body.username)
      if (body.username !== user.username || body.password !== password) {
        return Response.json({ error: 'Неверный логин или пароль' }, { status: 401 })
      }
      const token = `rc-${++n}`
      live.add(token)
      return Response.json({ auth_token: token, success: true })
    }
    if (!live.has(new Headers(init?.headers).get('X-User-Token') ?? '')) {
      return Response.json({ error: 'unauthorized' }, { status: 401 })
    }
    return rc.fetch(input, init)
  }
  return { fetch, live, signIns, headers: seen, setPassword: (p) => (password = p) }
}
