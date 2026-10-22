// OAuth 2.1 authorization server for the hosted MCP (architecture.md "Hosted: stateless OAuth", plan-m4.md).
import { Hono, type Context as HonoContext } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { cors } from 'hono/cors'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import { ACCESS_LEVELS, accessAllows, type Access } from '../config.js'
import { VERSION } from '../context.js'
import { ToolError } from '../domain/errors.js'
import { silentLogger, type Logger } from '../log.js'
import { getInfo, signIn } from '../upstream/api.js'
import { RcClient } from '../upstream/client.js'
import { redirectAllowed, type ClientInfo, type ClientRegistry } from './cimd.js'
import type { ServerKeys } from './keys.js'
import { errorPage, loginPage } from './login.js'
import { accountId } from '../ids.js'
import { open, seal, TTL, type TokenScope } from './tokens.js'

export interface OAuthOptions {
  /** e.g. https://rc.example.com (no trailing slash): the issuer; the MCP URL is publicUrl + /mcp. */
  publicUrl: string
  keys: ServerKeys
  /** RC_ACCESS: the highest level a connection may pick. */
  maxAccess: Access
  rcBaseUrl: string
  clients: ClientRegistry
  /** For RC calls (tests pass the fake RC). */
  fetch?: typeof fetch
  now?: () => Date
  log?: Logger
}

/** Request variables set by hosted.ts for logs and RC calls; `client` and `account` once the caller is known. */
export type HttpEnv = {
  Variables: { ip: string | undefined; requestId: string; client?: string; account?: string }
}

/** Fields every log line of a request carries, so one request's lines (and one user's) can be found together. */
export function requestFields(c: HonoContext<HttpEnv>) {
  return { request_id: c.get('requestId'), ip: c.get('ip'), client: c.get('client'), account: c.get('account') }
}

/**
 * How our calls look to RealtyCalendar, so its side can tell our traffic apart and trace abuse: a User-Agent with the
 * version, the deployment and the MCP client, the client IP we saw as X-Forwarded-For, and our request id.
 */
export function upstreamIdentity(publicUrl: string, c: HonoContext<HttpEnv>) {
  const client = c.get('client')
  const ip = c.get('ip')
  return {
    userAgent: `realtycalendar-web-mcp/${VERSION} (+${urls(publicUrl).issuer}${client ? `; via ${client}` : ''})`,
    headers: { 'X-Request-Id': c.get('requestId'), ...(ip ? { 'X-Forwarded-For': ip } : {}) },
  }
}

/** claude.ai, chatgpt.com: the host of a CIMD client id. */
export function clientLabel(clientId: string): string {
  try {
    return new URL(clientId).host
  } catch {
    return 'unknown'
  }
}

export interface Bearer {
  token: string
  rcToken: string
  access: Access
  clientId: string
  /** Pseudonym of the RC login (ids.ts accountId). */
  account: string
  scopes: string[]
  expiresAt: number
}

const FORM_LIMIT = 16 * 1024
const COOKIE = 'rc_login' // sent as __Host-rc_login (prefix: 'host')
const SCOPES = ['offline_access']

export function urls(publicUrl: string) {
  const issuer = publicUrl.replace(/\/+$/, '')
  return {
    issuer,
    resource: `${issuer}/mcp`,
    resourceMetadata: `${issuer}/.well-known/oauth-protected-resource`,
  }
}

function scopeOf(o: OAuthOptions): TokenScope {
  const u = urls(o.publicUrl)
  return { keys: o.keys, issuer: u.issuer, audience: u.resource, now: o.now ?? (() => new Date()) }
}

/** The 401 that starts (or restarts) sign-in in Claude and ChatGPT. */
export function unauthorized(o: Pick<OAuthOptions, 'publicUrl'>, invalidToken: boolean): Response {
  const u = urls(o.publicUrl)
  const params = [...(invalidToken ? ['error="invalid_token"'] : []), `resource_metadata="${u.resourceMetadata}"`]
  return new Response(JSON.stringify({ error: invalidToken ? 'invalid_token' : 'unauthorized' }), {
    status: 401,
    headers: { 'Content-Type': 'application/json', 'WWW-Authenticate': `Bearer ${params.join(', ')}` },
  })
}

/** The access token of a /mcp request, or the 401 to answer with. */
export async function bearer(req: Request, o: OAuthOptions): Promise<Bearer | Response> {
  const m = req.headers.get('Authorization')?.match(/^Bearer\s+(\S+)\s*$/i)
  if (!m) return unauthorized(o, false)
  const claims = await open(scopeOf(o), 'access', m[1]!)
  if (!claims) return unauthorized(o, true)
  const access = accessAllows(o.maxAccess, claims.access) ? claims.access : o.maxAccess
  return {
    token: m[1]!,
    rcToken: claims.rc_token,
    access,
    clientId: claims.client_id,
    account: claims.sub,
    scopes: claims.scope ? claims.scope.split(' ') : [],
    expiresAt: (claims as unknown as { exp: number }).exp,
  }
}

export function oauthApp(o: OAuthOptions): Hono<HttpEnv> {
  const app = new Hono<HttpEnv>()
  const u = urls(o.publicUrl)
  const ts = scopeOf(o)
  const log = o.log ?? silentLogger
  const rc = (c: HonoContext<HttpEnv>, token: string) =>
    new RcClient(token, { baseUrl: o.rcBaseUrl, fetch: o.fetch, log, ...upstreamIdentity(o.publicUrl, c) })

  // Browser-based clients (MCP Inspector) read metadata and call /token cross-origin.
  const openCors = cors({ origin: '*', allowMethods: ['GET', 'POST', 'OPTIONS'], maxAge: 600 })
  app.use('/.well-known/*', openCors)
  app.use('/token', openCors)
  const formLimit = bodyLimit({ maxSize: FORM_LIMIT, onError: (c) => c.json({ error: 'invalid_request' }, 413) })
  app.use('/token', formLimit)
  app.use('/login', formLimit)

  const protectedResource = (c: HonoContext<HttpEnv>) =>
    c.json({
      resource: u.resource,
      authorization_servers: [u.issuer],
      scopes_supported: SCOPES,
      bearer_methods_supported: ['header'],
      resource_name: 'RealtyCalendar',
    })
  app.get('/.well-known/oauth-protected-resource', protectedResource)
  app.get('/.well-known/oauth-protected-resource/mcp', protectedResource)

  const asMetadata = (c: HonoContext<HttpEnv>) =>
    c.json({
      issuer: u.issuer,
      authorization_endpoint: `${u.issuer}/authorize`,
      token_endpoint: `${u.issuer}/token`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      client_id_metadata_document_supported: true,
      authorization_response_iss_parameter_supported: true,
      scopes_supported: SCOPES,
    })
  app.get('/.well-known/oauth-authorization-server', asMetadata)
  app.get('/.well-known/oauth-authorization-server/mcp', asMetadata)

  app.get('/authorize', async (c) => {
    const q = c.req.query()
    secureHeaders(c)
    // Before the client and redirect URI are known good, errors are shown here, never redirected (RFC 6749 §4.1.2.1).
    const client = q.client_id ? await o.clients.get(q.client_id) : undefined
    if (!client) return c.html(errorPage('Это приложение не может подключаться к серверу.'), 400)
    c.set('client', clientLabel(client.client_id))
    const redirectUri = q.redirect_uri ?? (client.redirect_uris.length === 1 ? client.redirect_uris[0]! : '')
    if (!redirectAllowed(client, redirectUri)) {
      return c.html(errorPage('Адрес возврата не совпадает с адресами приложения.'), 400)
    }
    const fail = (error: string, description: string) =>
      c.redirect(callback(redirectUri, { error, error_description: description, state: q.state, iss: u.issuer }), 302)
    if (q.response_type !== 'code') return fail('unsupported_response_type', 'response_type must be code')
    if (!q.code_challenge || q.code_challenge_method !== 'S256') {
      return fail('invalid_request', 'PKCE with code_challenge_method=S256 is required')
    }
    if (q.resource !== undefined && q.resource !== u.resource)
      return fail('invalid_target', `resource must be ${u.resource}`)
    const scope = (q.scope ?? '')
      .split(' ')
      .filter((s) => SCOPES.includes(s))
      .join(' ')
    const login = await seal(ts, 'login', {
      client_id: client.client_id,
      scope,
      access: 'read',
      redirect_uri: redirectUri,
      code_challenge: q.code_challenge,
      ...(q.state !== undefined ? { state: q.state } : {}),
    })
    setCookie(c, COOKIE, login, {
      path: '/',
      secure: true,
      httpOnly: true,
      sameSite: 'Lax',
      maxAge: TTL.login,
      prefix: 'host',
    })
    return c.html(loginPage(pageProps(client, redirectUri, o.maxAccess)))
  })

  app.post('/login', async (c) => {
    secureHeaders(c)
    const cookie = getCookie(c, COOKIE, 'host')
    const login = cookie ? await open(ts, 'login', cookie) : undefined
    if (!login) return c.html(errorPage('Время на вход истекло или вход начат в другом браузере.'), 400)
    c.set('client', clientLabel(login.client_id))
    const client = await o.clients.get(login.client_id)
    if (!client) return c.html(errorPage('Это приложение не может подключаться к серверу.'), 400)
    const form = await c.req.parseBody()
    const field = (k: string) => (typeof form[k] === 'string' ? (form[k] as string) : '')
    const back = (params: Record<string, string | undefined>) => {
      deleteCookie(c, COOKIE, { path: '/', secure: true, prefix: 'host' })
      return c.redirect(callback(login.redirect_uri, { ...params, state: login.state, iss: u.issuer }), 303)
    }
    if (field('action') === 'deny') return back({ error: 'access_denied', error_description: 'The user declined' })

    const username = field('username').trim()
    const password = field('password')
    const picked = field('access') as Access
    const access = ACCESS_LEVELS.includes(picked) && accessAllows(o.maxAccess, picked) ? picked : 'read'
    const again = (error: string, status: 200 | 502 = 200) =>
      c.html(loginPage({ ...pageProps(client, login.redirect_uri, o.maxAccess), access, username, error }), status)
    if (!username || !password) return again('Введите логин и пароль.')
    const sub = await accountId(username)
    c.set('account', sub)
    let rcToken: string
    try {
      rcToken = (await signIn(rc(c, ''), username, password)).auth_token
    } catch (e) {
      if (e instanceof ToolError && (e.code === 'AUTH' || e.code === 'VALIDATION')) {
        log.log('info', 'oauth_login_rejected', { ...requestFields(c), client_id: client.client_id })
        return again('Неверный логин или пароль RealtyCalendar.')
      }
      log.log('warn', 'oauth_login_failed', { ...requestFields(c), client_id: client.client_id, error: String(e) })
      return again('RealtyCalendar сейчас недоступен. Попробуйте ещё раз.', 502)
    }
    const code = await seal(ts, 'code', {
      client_id: login.client_id,
      scope: login.scope,
      access,
      redirect_uri: login.redirect_uri,
      code_challenge: login.code_challenge,
      sub,
      rc_token: rcToken,
      rc_user: username,
      rc_password: password,
    })
    log.log('info', 'oauth_login', { ...requestFields(c), client_id: client.client_id, access })
    return back({ code })
  })

  app.post('/token', async (c) => {
    c.header('Cache-Control', 'no-store')
    const fail = (error: string, description: string, status: 400 | 503 = 400) =>
      c.json({ error, error_description: description }, status)
    const type = c.req.header('Content-Type') ?? ''
    if (!type.startsWith('application/x-www-form-urlencoded')) {
      return fail('invalid_request', 'Use application/x-www-form-urlencoded')
    }
    const form = await c.req.parseBody()
    const f = (k: string) => (typeof form[k] === 'string' ? (form[k] as string) : undefined)
    if (f('resource') !== undefined && f('resource') !== u.resource) {
      return fail('invalid_target', `resource must be ${u.resource}`)
    }

    if (f('grant_type') === 'authorization_code') {
      const code = await open(ts, 'code', f('code') ?? '')
      if (!code) return fail('invalid_grant', 'Code is invalid or expired')
      c.set('client', clientLabel(code.client_id))
      c.set('account', code.sub)
      if (f('client_id') !== code.client_id) return fail('invalid_grant', 'Code was issued to another client')
      if (f('redirect_uri') !== code.redirect_uri) return fail('invalid_grant', 'redirect_uri does not match')
      const verifier = f('code_verifier')
      if (!verifier || (await s256(verifier)) !== code.code_challenge) {
        return fail('invalid_grant', 'PKCE verification failed')
      }
      log.log('info', 'oauth_token', { ...requestFields(c), client_id: code.client_id, grant: 'authorization_code' })
      return c.json(await issue(code))
    }

    if (f('grant_type') === 'refresh_token') {
      const refresh = await open(ts, 'refresh', f('refresh_token') ?? '')
      if (!refresh) return fail('invalid_grant', 'Refresh token is invalid or expired')
      c.set('client', clientLabel(refresh.client_id))
      c.set('account', refresh.sub)
      if (f('client_id') !== undefined && f('client_id') !== refresh.client_id) {
        return fail('invalid_grant', 'Refresh token was issued to another client')
      }
      let rcToken = refresh.rc_token
      try {
        await getInfo(rc(c, rcToken))
      } catch (e) {
        if (!(e instanceof ToolError && e.code === 'AUTH')) {
          log.log('warn', 'oauth_refresh_rc_unavailable', {
            ...requestFields(c),
            client_id: refresh.client_id,
            error: String(e),
          })
          return fail('temporarily_unavailable', 'RealtyCalendar is not reachable', 503)
        }
        // The RC session died: sign in again with the stored login.
        try {
          rcToken = (await signIn(rc(c, ''), refresh.rc_user, refresh.rc_password)).auth_token
          log.log('info', 'oauth_rc_relogin', { ...requestFields(c), client_id: refresh.client_id })
        } catch (e2) {
          if (e2 instanceof ToolError && (e2.code === 'AUTH' || e2.code === 'VALIDATION')) {
            log.log('info', 'oauth_relogin_rejected', { ...requestFields(c), client_id: refresh.client_id })
            return fail('invalid_grant', 'RealtyCalendar login no longer works; reconnect')
          }
          log.log('warn', 'oauth_relogin_failed', {
            ...requestFields(c),
            client_id: refresh.client_id,
            error: String(e2),
          })
          return fail('temporarily_unavailable', 'RealtyCalendar is not reachable', 503)
        }
      }
      log.log('info', 'oauth_token', { ...requestFields(c), client_id: refresh.client_id, grant: 'refresh_token' })
      return c.json(await issue({ ...refresh, rc_token: rcToken }))
    }

    return fail('unsupported_grant_type', 'Use authorization_code or refresh_token')
  })

  async function issue(g: {
    client_id: string
    scope: string
    access: Access
    sub: string
    rc_token: string
    rc_user: string
    rc_password: string
  }) {
    const common = { client_id: g.client_id, scope: g.scope, access: g.access, sub: g.sub }
    return {
      access_token: await seal(ts, 'access', { ...common, rc_token: g.rc_token }),
      token_type: 'Bearer',
      expires_in: TTL.access,
      refresh_token: await seal(ts, 'refresh', {
        ...common,
        rc_token: g.rc_token,
        rc_user: g.rc_user,
        rc_password: g.rc_password,
      }),
      scope: g.scope,
    }
  }

  return app
}

function pageProps(client: ClientInfo, redirectUri: string, maxAccess: Access) {
  const r = new URL(redirectUri)
  return {
    clientName: client.client_name,
    redirectHost: r.host,
    loopback: r.protocol === 'http:',
    maxAccess,
  }
}

function secureHeaders(c: HonoContext) {
  c.header('Cache-Control', 'no-store')
  c.header('X-Frame-Options', 'DENY')
  c.header('Referrer-Policy', 'no-referrer')
  c.header(
    'Content-Security-Policy',
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https: http://localhost:* http://127.0.0.1:*; frame-ancestors 'none'",
  )
}

function callback(redirectUri: string, params: Record<string, string | undefined>): string {
  const url = new URL(redirectUri)
  for (const [k, v] of Object.entries(params)) if (v !== undefined) url.searchParams.set(k, v)
  return url.toString()
}

async function s256(verifier: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)))
  return btoa(String.fromCharCode(...digest))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}
