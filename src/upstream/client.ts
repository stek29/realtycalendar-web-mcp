import type { ZodType } from 'zod'
import { ToolError } from '../domain/errors.js'
import { redact } from '../domain/redact.js'
import { silentLogger, type Logger } from '../log.js'

export type QueryValue = string | number | boolean | readonly (string | number)[] | null | undefined
export type Query = Record<string, QueryValue>

export interface RcClientOptions {
  baseUrl: string
  fetch?: typeof fetch
  log?: Logger
  userAgent?: string
  timeoutMs?: number
  /** Delay before the one GET retry; tests set 0. */
  retryDelayMs?: () => number
  /** Extra headers on every request, e.g. X-Forwarded-For and X-Request-Id in hosted mode; can't override ours. */
  headers?: Record<string, string>
  /** Called when RC answers 401; hosted turns the whole HTTP request into a 401 (architecture.md "Hosted"). */
  onUnauthorized?: () => void
}

const MAX_CONCURRENT = 4
const OCCUPIED = 'На данные числа объект занят'
const ROOM_NOT_FOUND = 'Комната не найдена'
const DATE_FIELDS = new Set(['begin_date', 'end_date'])

/** Rails-style query: arrays as key[]=a&key[]=b. `apartment_ids` is passed in already comma-joined. */
export function encodeQuery(query: Query): string {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) {
    if (value == null) continue
    if (Array.isArray(value)) for (const v of value) params.append(`${key}[]`, String(v))
    else params.append(key, String(value))
  }
  const s = params.toString()
  return s ? `?${s}` : ''
}

/** The only code that talks to RealtyCalendar: headers, timeouts, retries, error mapping, response validation. */
export class RcClient {
  private readonly fetch: typeof fetch
  private readonly log: Logger
  private readonly timeoutMs: number
  private readonly retryDelayMs: () => number
  private active = 0
  private readonly waiting: (() => void)[] = []

  constructor(
    private readonly token: string,
    private readonly opts: RcClientOptions,
  ) {
    this.fetch = opts.fetch ?? globalThis.fetch.bind(globalThis)
    this.log = opts.log ?? silentLogger
    this.timeoutMs = opts.timeoutMs ?? 15_000
    this.retryDelayMs = opts.retryDelayMs ?? (() => 300 + Math.random() * 700)
  }

  /** GET with one retry on network errors and 5xx; the response is validated against `schema`. */
  async get<T>(path: string, query: Query, schema: ZodType<T>): Promise<T> {
    return this.parse(path, await this.request('GET', path + encodeQuery(query), undefined, true), schema)
  }

  /** A write or a read sent as POST. Never retried. */
  async send<T>(method: 'POST' | 'PUT' | 'DELETE', path: string, body: unknown, schema: ZodType<T>): Promise<T> {
    return this.parse(path, await this.request(method, path, body, false), schema)
  }

  private parse<T>(path: string, body: unknown, schema: ZodType<T>): T {
    const result = schema.safeParse(body)
    if (result.success) return result.data
    // Paths and messages only: values could carry guest data.
    const issues = result.error.issues.slice(0, 5).map((i) => `${i.path.join('.')}: ${i.message}`)
    this.log.log('error', 'rc_schema_drift', { endpoint: path, issues })
    throw new ToolError(
      'RC_SCHEMA_DRIFT',
      `RealtyCalendar returned an unexpected response from ${path}`,
      'RealtyCalendar changed; report to the admin',
      { issues },
    )
  }

  private async request(method: string, pathAndQuery: string, body: unknown, retry: boolean): Promise<unknown> {
    const endpoint = `${method} ${pathAndQuery.split('?')[0]}`
    for (let attempt = 0; ; attempt++) {
      const started = Date.now()
      let res: Response
      try {
        res = await this.limited(() =>
          this.fetch(new URL(pathAndQuery, this.opts.baseUrl), {
            method,
            headers: {
              ...this.opts.headers,
              // No token only for sign-in.
              ...(this.token ? { 'X-User-Token': this.token } : {}),
              'X-Locale': 'ru',
              'Content-Type': 'application/json',
              Accept: 'application/json',
              ...(this.opts.userAgent ? { 'User-Agent': this.opts.userAgent } : {}),
            },
            body: body === undefined ? undefined : JSON.stringify(body),
            signal: AbortSignal.timeout(this.timeoutMs),
          }),
        )
      } catch (e) {
        this.log.log('warn', 'rc_network_error', {
          endpoint,
          attempt,
          duration_ms: Date.now() - started,
          error: String(e),
        })
        if (retry && attempt === 0) {
          await sleep(this.retryDelayMs())
          continue
        }
        throw new ToolError('RC_ERROR', `RealtyCalendar is not reachable (${endpoint})`, 'Try again later')
      }
      this.log.log(res.ok ? 'info' : 'warn', 'rc_request', {
        endpoint,
        status: res.status,
        attempt,
        duration_ms: Date.now() - started,
      })
      if ((res.status >= 500 || res.status === 429) && retry && attempt === 0) {
        await sleep(retryAfterMs(res.headers.get('Retry-After')) ?? this.retryDelayMs())
        continue
      }
      const parsed = await readJson(res)
      if (res.ok) return parsed
      throw this.mapError(res.status, parsed, endpoint)
    }
  }

  private mapError(status: number, body: unknown, endpoint: string): ToolError {
    if (status === 401) {
      this.opts.onUnauthorized?.()
      return new ToolError(
        'AUTH',
        'RealtyCalendar rejected the token',
        'RC token expired; the admin must update RC_TOKEN',
      )
    }
    if (status === 404)
      return new ToolError('NOT_FOUND', 'Not found in RealtyCalendar', 'Check the id; find it with list_bookings')
    if (status === 400 && isObject(body) && body.error === 'date range') {
      return new ToolError(
        'RANGE_TOO_LONG',
        'RealtyCalendar refused the date range as too long',
        'Split or narrow the range',
      )
    }
    if (status === 422 && isObject(body)) {
      const errors = body.errors
      if (Array.isArray(errors)) {
        // Strict-schema errors (array of strings): our request body was wrong.
        return new ToolError('VALIDATION', 'RealtyCalendar rejected the request', undefined, {
          rc_errors: redact(errors.slice(0, 5)),
        })
      }
      if (isObject(errors)) {
        const messages = Object.values(errors).flat().map(String)
        if (messages.some((m) => m.includes(OCCUPIED))) {
          return new ToolError(
            'OCCUPIED',
            'The room or category is occupied on these dates',
            "Don't retry. Offer other rooms from check_availability.",
          )
        }
        if (messages.some((m) => m.includes(ROOM_NOT_FOUND))) {
          this.log.log('error', 'invariant_room_not_in_category', { endpoint })
          return new ToolError('ROOM_NOT_IN_CATEGORY', 'RealtyCalendar says the room is not in this category')
        }
        if (Object.keys(errors).some((k) => DATE_FIELDS.has(k))) {
          return new ToolError('INVALID_DATES', messages.join('; '))
        }
        return new ToolError('VALIDATION', 'RealtyCalendar rejected the request', undefined, {
          rc_errors: redact(errors),
        })
      }
    }
    return new ToolError(
      'RC_ERROR',
      `RealtyCalendar error ${status} (${endpoint})`,
      status >= 500 ? 'Try again later' : undefined,
    )
  }

  private async limited<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= MAX_CONCURRENT) await new Promise<void>((resolve) => this.waiting.push(resolve))
    this.active++
    try {
      return await fn()
    } finally {
      this.active--
      this.waiting.shift()?.()
    }
  }
}

async function readJson(res: Response): Promise<unknown> {
  const text = await res.text()
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

function retryAfterMs(header: string | null): number | undefined {
  if (!header) return undefined
  const sec = Number(header)
  return Number.isFinite(sec) ? Math.min(sec, 10) * 1000 : undefined
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
