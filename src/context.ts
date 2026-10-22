import { noAudit, type AuditSink } from './audit.js'
import type { Cache } from './cache.js'
import type { Config } from './config.js'
import { buildCatalog, type Catalog } from './domain/catalog.js'
import { silentLogger, type Logger } from './log.js'
import { getApartmentInfo, getApartments, getInfo } from './upstream/api.js'
import { RcClient } from './upstream/client.js'

export const VERSION = '1.0.0'
const CATALOG_TTL_SEC = 600

/** Built per connection (stdio) or per request (HTTP); never shared between users. */
export interface Context {
  rc: RcClient
  /** Categories, rooms, sources, currency; cached 10 min. `refresh` reloads (used once on a name miss). */
  catalog(opts?: { refresh?: boolean }): Promise<Catalog>
  now(): Date
  config: Config
  log: Logger
  audit: AuditSink
  /** Runs `fn` after any earlier write to the same booking id has finished (writes serialised in-process). */
  withBookingLock<T>(id: number, fn: () => Promise<T>): Promise<T>
}

export interface ContextOptions {
  fetch?: typeof fetch
  log?: Logger
  audit?: AuditSink
  now?: () => Date
}

export function makeContext(rcToken: string, config: Config, cache: Cache, opts: ContextOptions = {}): Context {
  const log = opts.log ?? silentLogger
  const rc = new RcClient(rcToken, {
    baseUrl: config.rcBaseUrl,
    fetch: opts.fetch,
    log,
    userAgent: `realtycalendar-web-mcp/${VERSION}`,
  })
  let loading: Promise<Catalog> | undefined
  const locks = new Map<number, Promise<unknown>>()

  async function load(key: string): Promise<Catalog> {
    const [apartments, info] = await Promise.all([getApartments(rc), getInfo(rc)])
    const guests = await Promise.all(apartments.apartments.map((a) => getApartmentInfo(rc, a.id)))
    const catalog = buildCatalog(apartments, new Map(guests.map((g) => [g.id, g.guests])), info)
    await cache.set(key, catalog, CATALOG_TTL_SEC)
    return catalog
  }

  return {
    rc,
    config,
    log,
    audit: opts.audit ?? noAudit,
    now: opts.now ?? (() => new Date()),
    async withBookingLock(id, fn) {
      const previous = locks.get(id) ?? Promise.resolve()
      const run = previous.catch(() => {}).then(fn)
      const tail = run.catch(() => {})
      locks.set(id, tail)
      void tail.then(() => locks.get(id) === tail && locks.delete(id))
      return run
    },
    async catalog({ refresh = false } = {}) {
      // Keyed by a hash of the RC token, so a shared cache never mixes users.
      const key = `catalog:${await sha256(rcToken)}`
      if (!refresh) {
        const cached = await cache.get<Catalog>(key)
        if (cached) return cached
      }
      loading ??= load(key).finally(() => (loading = undefined))
      return loading
    },
  }
}

async function sha256(s: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}
