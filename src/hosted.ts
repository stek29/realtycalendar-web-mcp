// The hosted server as a Hono app: OAuth routes, /mcp (Streamable HTTP, stateless), /healthz. Web-standard only;
// platforms/node.ts serves it.
import { createMcpHandler } from '@modelcontextprotocol/server'
import { Hono, type Context as HonoContext } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { cors } from 'hono/cors'
import { clientIp } from './client-ip.js'
import { streamAudit } from './audit.js'
import type { Cache } from './cache.js'
import type { Config } from './config.js'
import { makeContext, type Context } from './context.js'
import { newRequestId } from './ids.js'
import { jsonLogger, type Logger } from './log.js'
import { createMcpServer } from './mcp/server.js'
import {
  bearer,
  clientLabel,
  oauthApp,
  requestFields,
  unauthorized,
  upstreamIdentity,
  type HttpEnv,
  type OAuthOptions,
} from './oauth/app.js'

export interface HostedOptions extends Omit<OAuthOptions, 'maxAccess' | 'rcBaseUrl' | 'log'> {
  /** Server-wide config; `access` is the highest level a connection may pick, `confirmKey` comes from the server key. */
  config: Config
  cache: Cache
  /** Log and audit lines (stdout in node.ts). */
  write: (line: string) => void
  /** The TCP peer's address (platform-specific). */
  socketIp?: (c: HonoContext<HttpEnv>) => string | undefined
  /** MCP_TRUST_PROXY_HOPS: reverse proxies in front that append to X-Forwarded-For (default 0: use the peer). */
  trustProxyHops?: number
}

const MCP_BODY_LIMIT = 1024 * 1024

export function hostedApp(o: HostedOptions): Hono<HttpEnv> {
  const log = jsonLogger(o.write)
  const oauth: OAuthOptions = { ...o, maxAccess: o.config.access, rcBaseUrl: o.config.rcBaseUrl, log }
  const app = new Hono<HttpEnv>()

  app.get('/healthz', (c) => c.text('ok'))
  // One access line per request: path without the query (codes and states ride in it), status, the real client IP.
  app.use('*', async (c, next) => {
    const started = Date.now()
    c.set('requestId', newRequestId())
    c.set('ip', clientIp(o.socketIp?.(c), c.req.header('X-Forwarded-For'), o.trustProxyHops ?? 0))
    await next()
    c.res.headers.set('X-Request-Id', c.get('requestId'))
    log.log(c.res.status >= 500 ? 'error' : 'info', 'http', {
      ...requestFields(c),
      method: c.req.method,
      path: c.req.path,
      status: c.res.status,
      duration_ms: Date.now() - started,
      user_agent: c.req.header('User-Agent')?.slice(0, 200),
    })
  })
  app.route('/', oauthApp(oauth))

  // The factory gets the request's Context through authInfo.extra: one handler, a fresh server per request.
  const handler = createMcpHandler((req) => createMcpServer((req.authInfo?.extra as { ctx: Context }).ctx), {
    legacy: 'stateless',
    onerror: (e) => log.log('warn', 'mcp_error', { error: String(e) }),
  })

  app.use(
    '/mcp',
    cors({
      origin: '*',
      allowMethods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
      allowHeaders: [
        'Authorization',
        'Content-Type',
        'Accept',
        'Mcp-Protocol-Version',
        'Mcp-Session-Id',
        'Last-Event-ID',
      ],
      exposeHeaders: ['WWW-Authenticate', 'Mcp-Session-Id', 'Mcp-Protocol-Version'],
      maxAge: 600,
    }),
  )
  app.use('/mcp', bodyLimit({ maxSize: MCP_BODY_LIMIT, onError: (c) => c.json({ error: 'request too large' }, 413) }))
  app.all('/mcp', async (c) => {
    const auth = await bearer(c.req.raw, oauth)
    if (auth instanceof Response) return auth
    c.set('client', clientLabel(auth.clientId))
    c.set('account', auth.account)
    let rcRejected = false
    const identity = upstreamIdentity(o.publicUrl, c)
    const ctx = makeContext(auth.rcToken, { ...o.config, access: auth.access }, o.cache, {
      fetch: o.fetch,
      now: o.now,
      // Tool and RC lines carry the request's fields too: one request, one user, all their lines.
      log: withFields(jsonLogger(o.write, [auth.rcToken, auth.token]), requestFields(c)),
      userAgent: identity.userAgent,
      rcHeaders: identity.headers,
      audit: streamAudit(o.write, o.config.audit),
      onUnauthorized: () => (rcRejected = true),
    })
    const res = await handler.fetch(c.req.raw, {
      authInfo: {
        token: auth.token,
        clientId: auth.clientId,
        scopes: auth.scopes,
        expiresAt: auth.expiresAt,
        extra: { ctx },
      },
    })
    if (c.req.method !== 'POST') return res
    // Read the whole answer first: an RC 401 anywhere in it turns the request into an HTTP 401, so the client
    // refreshes (and the refresh signs in to RC again) instead of showing the model an AUTH error.
    const body = await res.arrayBuffer()
    if (rcRejected) return unauthorized(oauth, true)
    return new Response(body, { status: res.status, headers: res.headers })
  })

  app.onError((e, c) => {
    log.log('error', 'http_error', { path: c.req.path, error: String(e) })
    return c.json({ error: 'server_error' }, 500)
  })
  return app
}

function withFields(base: Logger, fields: Record<string, unknown>): Logger {
  return { log: (level, event, extra) => base.log(level, event, { ...fields, ...extra }) }
}
