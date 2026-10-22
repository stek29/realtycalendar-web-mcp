// Hosted OAuth (plan-m4.md "Tests"): the full flow with a fake RC that signs in and checks tokens, and fake clients.
import { describe, expect, it } from 'vitest'
import { memoryCache } from '../../src/cache.js'
import { parseConfig, type Access } from '../../src/config.js'
import { hostedApp } from '../../src/hosted.js'
import { clientIp } from '../../src/client-ip.js'
import { cimdRegistry, redirectAllowed, ALLOWED_CLIENTS } from '../../src/oauth/cimd.js'
import { serverKeys } from '../../src/oauth/keys.js'
import { open, seal } from '../../src/oauth/tokens.js'
import { signInRc } from '../fake-rc.js'

const PUBLIC = 'https://rc.example.test'
const MCP = `${PUBLIC}/mcp`
const CLAUDE = 'https://claude.ai/oauth/mcp-oauth-client-metadata'
const CLAUDE_CB = 'https://claude.ai/api/mcp/auth_callback'
const CLAUDE_CODE = 'https://claude.ai/oauth/claude-code-client-metadata'
const CHATGPT = 'https://chatgpt.com/oauth/client.json'
const KEY = 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY' // 32 bytes, base64url
const KEY2 = 'ZmVkY2JhOTg3NjU0MzIxMGZlZGNiYTk4NzY1NDMyMTA'
const VERIFIER = 'a-verifier-that-is-long-enough-for-pkce-0123456789abcdef'
const USER = 'owner@example.com'
const PASSWORD = 'correct horse'

const DOCS: Record<string, unknown> = {
  [CLAUDE]: { client_id: CLAUDE, client_name: 'Claude', redirect_uris: [CLAUDE_CB] },
  [CLAUDE_CODE]: {
    client_id: CLAUDE_CODE,
    client_name: 'Claude Code',
    redirect_uris: ['http://localhost/callback', 'http://127.0.0.1/callback'],
  },
  [CHATGPT]: {
    client_id: CHATGPT,
    client_name: 'ChatGPT',
    redirect_uris: ['https://chatgpt.com/connector_platform_oauth_redirect'],
  },
}

async function s256(v: string) {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(v)))
  return Buffer.from(d).toString('base64url')
}

async function setup(opts: { maxAccess?: Access; now?: () => Date; previousKey?: string; key?: string } = {}) {
  const rc = signInRc({ username: USER, password: PASSWORD })
  const lines: string[] = []
  const clock = { now: opts.now ?? (() => new Date()) }
  const keys = await serverKeys(opts.key ?? KEY, opts.previousKey)
  const cimdFetch: typeof fetch = async (input) => {
    const doc = DOCS[String(input)]
    return doc ? Response.json(doc) : new Response('nope', { status: 404 })
  }
  const app = hostedApp({
    publicUrl: PUBLIC,
    keys,
    config: { ...parseConfig({ RC_ACCESS: opts.maxAccess ?? 'full' }), confirmKey: keys.confirmKey },
    cache: memoryCache(),
    clients: cimdRegistry({ fetch: cimdFetch }),
    fetch: rc.fetch,
    now: () => clock.now(),
    write: (l) => lines.push(l),
    socketIp: () => '10.0.0.5',
    trustProxyHops: 1,
  })
  const req = (path: string, init?: RequestInit) => app.request(`${PUBLIC}${path}`, init)

  /** GET /authorize; returns the response and the login cookie. */
  async function authorize(params: Record<string, string | undefined> = {}) {
    const q = new URLSearchParams()
    const all = {
      response_type: 'code',
      client_id: CLAUDE,
      redirect_uri: CLAUDE_CB,
      code_challenge: await s256(VERIFIER),
      code_challenge_method: 'S256',
      state: 'st-1',
      scope: 'offline_access',
      resource: MCP,
      ...params,
    }
    for (const [k, v] of Object.entries(all)) if (v !== undefined) q.set(k, v)
    const res = await req(`/authorize?${q}`)
    const cookie = res.headers.get('Set-Cookie')?.split(';')[0]
    return { res, cookie }
  }

  async function login(cookie: string | undefined, form: Record<string, string> = {}) {
    return req('/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...(cookie ? { Cookie: cookie } : {}) },
      body: new URLSearchParams({ username: USER, password: PASSWORD, access: 'edit', action: 'allow', ...form }),
    })
  }

  async function token(form: Record<string, string>) {
    const res = await req('/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(form),
    })
    return { status: res.status, body: (await res.json()) as Record<string, string> }
  }

  /** The whole flow up to tokens. */
  async function connect(form: Record<string, string> = {}) {
    const { cookie } = await authorize()
    const res = await login(cookie, form)
    const code = new URL(res.headers.get('Location')!).searchParams.get('code')!
    const t = await token({
      grant_type: 'authorization_code',
      code,
      client_id: CLAUDE,
      redirect_uri: CLAUDE_CB,
      code_verifier: VERIFIER,
      resource: MCP,
    })
    expect(t.status).toBe(200)
    return t.body as { access_token: string; refresh_token: string }
  }

  async function mcp(accessToken: string | undefined, method: string, params: Record<string, unknown> = {}) {
    return req('/mcp', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'Mcp-Protocol-Version': '2025-06-18',
        ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    })
  }

  return { app, req, rc, lines, clock, keys, authorize, login, token, connect, mcp }
}

async function rpcResult(res: Response) {
  const text = await res.text()
  const json = text.startsWith('{')
    ? JSON.parse(text)
    : JSON.parse(
        text
          .split('\n')
          .find((l) => l.startsWith('data:'))!
          .slice(5),
      )
  return json.result
}

describe('metadata', () => {
  it('serves protected resource and authorization server metadata as Claude and ChatGPT need them', async () => {
    const { req } = await setup()
    const pr = await (await req('/.well-known/oauth-protected-resource')).json()
    expect(pr).toMatchObject({ resource: MCP, authorization_servers: [PUBLIC], scopes_supported: ['offline_access'] })
    const as = await (await req('/.well-known/oauth-authorization-server')).json()
    expect(as).toMatchObject({
      issuer: PUBLIC,
      authorization_endpoint: `${PUBLIC}/authorize`,
      token_endpoint: `${PUBLIC}/token`,
      client_id_metadata_document_supported: true,
      token_endpoint_auth_methods_supported: ['none'],
      code_challenge_methods_supported: ['S256'],
      authorization_response_iss_parameter_supported: true,
      scopes_supported: ['offline_access'],
    })
    expect(as.registration_endpoint).toBeUndefined()
    expect((await req('/healthz')).status).toBe(200)
  })

  it('answers /mcp without a token with 401 and resource_metadata, and a bad token with invalid_token', async () => {
    const { mcp } = await setup()
    const none = await mcp(undefined, 'tools/list')
    expect(none.status).toBe(401)
    expect(none.headers.get('WWW-Authenticate')).toBe(
      `Bearer resource_metadata="${PUBLIC}/.well-known/oauth-protected-resource"`,
    )
    const bad = await mcp('garbage', 'tools/list')
    expect(bad.status).toBe(401)
    expect(bad.headers.get('WWW-Authenticate')).toContain('error="invalid_token"')
  })
})

describe('authorization code flow', () => {
  it('connects, lists tools at the picked level, calls a tool and refreshes', async () => {
    const s = await setup({ maxAccess: 'full' })
    const { res, cookie } = await s.authorize()
    expect(res.status).toBe(200)
    expect(cookie).toMatch(/^__Host-rc_login=/)
    const page = await res.text()
    expect(page).toContain('Claude')
    expect(page).toContain('claude.ai')

    const back = await s.login(cookie, { access: 'book' })
    expect(back.status).toBe(303)
    const loc = new URL(back.headers.get('Location')!)
    expect(loc.origin + loc.pathname).toBe(CLAUDE_CB)
    expect(loc.searchParams.get('iss')).toBe(PUBLIC)
    expect(loc.searchParams.get('state')).toBe('st-1')

    const t = await s.token({
      grant_type: 'authorization_code',
      code: loc.searchParams.get('code')!,
      client_id: CLAUDE,
      redirect_uri: CLAUDE_CB,
      code_verifier: VERIFIER,
      resource: MCP,
    })
    expect(t.status).toBe(200)
    expect(t.body).toMatchObject({ token_type: 'Bearer', expires_in: 900, scope: 'offline_access' })

    const list = await s.mcp(t.body.access_token, 'tools/list')
    expect(list.status).toBe(200)
    const names = ((await rpcResult(list)).tools as { name: string }[]).map((x) => x.name).sort()
    expect(names).toEqual([
      'check_availability',
      'create_booking',
      'get_booking',
      'list_bookings',
      'list_rooms',
      'preview_create_booking',
    ])

    const call = await s.mcp(t.body.access_token, 'tools/call', { name: 'list_rooms', arguments: {} })
    expect(call.status).toBe(200)
    expect((await rpcResult(call)).isError).toBeFalsy()

    const r = await s.token({ grant_type: 'refresh_token', refresh_token: t.body.refresh_token!, client_id: CLAUDE })
    expect(r.status).toBe(200)
    expect(r.body.access_token).toBeTruthy()
    expect(s.rc.signIns).toHaveLength(1) // the RC token was still alive: no second sign-in

    // Neither the password nor the RC token reaches the logs.
    const logs = s.lines.join('\n')
    expect(logs).not.toContain(PASSWORD)
    expect(logs).not.toMatch(/rc-1\b/)
  })

  it('caps the picked access level at RC_ACCESS', async () => {
    const s = await setup({ maxAccess: 'read' })
    const t = await s.connect({ access: 'full' })
    const names = ((await rpcResult(await s.mcp(t.access_token, 'tools/list'))).tools as { name: string }[]).map(
      (x) => x.name,
    )
    expect(names.sort()).toEqual(['check_availability', 'get_booking', 'list_bookings', 'list_rooms'])
  })

  it('works for ChatGPT and for Claude Code on any loopback port', async () => {
    const s = await setup()
    const gpt = await s.authorize({
      client_id: CHATGPT,
      redirect_uri: 'https://chatgpt.com/connector_platform_oauth_redirect',
    })
    expect(gpt.res.status).toBe(200)
    const cc = await s.authorize({ client_id: CLAUDE_CODE, redirect_uri: 'http://localhost:53123/callback' })
    expect(cc.res.status).toBe(200)
    expect(await cc.res.text()).toContain('на вашем компьютере')
  })

  it('re-renders the page on a wrong password and redirects access_denied on cancel, both with iss', async () => {
    const s = await setup()
    const { cookie } = await s.authorize()
    const wrong = await s.login(cookie, { password: 'nope' })
    expect(wrong.status).toBe(200)
    expect(await wrong.text()).toContain('Неверный логин или пароль')
    const deny = await s.login(cookie, { action: 'deny' })
    const loc = new URL(deny.headers.get('Location')!)
    expect(loc.searchParams.get('error')).toBe('access_denied')
    expect(loc.searchParams.get('iss')).toBe(PUBLIC)
    expect(loc.searchParams.get('state')).toBe('st-1')
  })

  it('needs the login cookie from /authorize', async () => {
    const s = await setup()
    expect((await s.login(undefined)).status).toBe(400)
    expect((await s.login('__Host-rc_login=forged')).status).toBe(400)
  })
})

describe('authorization request errors', () => {
  it('carries iss on every redirected error', async () => {
    const s = await setup()
    for (const [params, error] of [
      [{ response_type: 'token' }, 'unsupported_response_type'],
      [{ code_challenge_method: 'plain' }, 'invalid_request'],
      [{ code_challenge: undefined }, 'invalid_request'],
      [{ resource: 'https://other.example/mcp' }, 'invalid_target'],
    ] as const) {
      const { res } = await s.authorize(params)
      expect(res.status).toBe(302)
      const loc = new URL(res.headers.get('Location')!)
      expect(loc.searchParams.get('error')).toBe(error)
      expect(loc.searchParams.get('iss')).toBe(PUBLIC)
      expect(loc.searchParams.get('state')).toBe('st-1')
    }
  })

  it('never redirects to an unknown client or a redirect URI that is not an exact match', async () => {
    const s = await setup()
    for (const params of [
      { client_id: 'https://evil.example/client.json' },
      { redirect_uri: 'https://claude.ai/api/mcp/auth_callback/' },
      { redirect_uri: 'https://claude.ai/api/mcp/auth_callback?x=1' },
      { redirect_uri: 'https://evil.example/cb' },
      { redirect_uri: 'http://localhost:9999/callback' }, // loopback only for clients that registered one
      { client_id: CLAUDE_CODE, redirect_uri: 'http://localhost:9999/other' },
    ]) {
      const { res } = await s.authorize(params)
      expect(res.status, JSON.stringify(params)).toBe(400)
      expect(res.headers.get('Location')).toBeNull()
    }
  })

  it('rejects a CIMD document whose client_id is not its own URL', async () => {
    const registry = cimdRegistry({
      fetch: async () => Response.json({ client_id: 'https://other.example', redirect_uris: [CLAUDE_CB] }),
    })
    expect(await registry.get(CLAUDE)).toBeUndefined()
    expect(await registry.get('https://not-allowed.example/c.json')).toBeUndefined()
    expect(ALLOWED_CLIENTS).toContain(CLAUDE)
  })

  it('falls back to the bundled document when the fetch fails (e.g. a Cloudflare challenge)', async () => {
    const fallbacks: string[] = []
    const registry = cimdRegistry({
      fetch: async () => new Response('<html>challenge</html>', { status: 403 }),
      onFallback: (id) => fallbacks.push(id),
    })
    expect((await registry.get(CHATGPT))?.redirect_uris).toEqual([
      'https://chatgpt.com/connector_platform_oauth_redirect',
    ])
    const offline = cimdRegistry({ fetch: async () => Promise.reject(new TypeError('fetch failed')) })
    expect((await offline.get(CLAUDE))?.redirect_uris).toEqual([CLAUDE_CB])
    expect(fallbacks).toEqual([CHATGPT])
  })

  it('matches loopback redirects on any port, other URIs exactly', () => {
    const cc = DOCS[CLAUDE_CODE] as { client_id: string; client_name: string; redirect_uris: string[] }
    expect(redirectAllowed(cc, 'http://127.0.0.1:8000/callback')).toBe(true)
    expect(redirectAllowed(cc, 'http://localhost/callback')).toBe(true)
    expect(redirectAllowed(cc, 'https://localhost:8000/callback')).toBe(false)
    expect(redirectAllowed(cc, 'http://localhost.evil.example:8000/callback')).toBe(false)
  })
})

describe('token endpoint', () => {
  async function code(s: Awaited<ReturnType<typeof setup>>) {
    const { cookie } = await s.authorize()
    return new URL((await s.login(cookie)).headers.get('Location')!).searchParams.get('code')!
  }
  const exchange = (c: string, over: Record<string, string> = {}) => ({
    grant_type: 'authorization_code',
    code: c,
    client_id: CLAUDE,
    redirect_uri: CLAUDE_CB,
    code_verifier: VERIFIER,
    ...over,
  })

  it('checks verifier, redirect URI, client and resource', async () => {
    const s = await setup()
    const c = await code(s)
    expect((await s.token(exchange(c, { code_verifier: 'x'.repeat(50) }))).body.error).toBe('invalid_grant')
    expect((await s.token(exchange(c, { redirect_uri: 'https://claude.ai/other' }))).body.error).toBe('invalid_grant')
    expect((await s.token(exchange(c, { client_id: CHATGPT }))).body.error).toBe('invalid_grant')
    expect((await s.token(exchange(c, { resource: 'https://other.example/mcp' }))).body.error).toBe('invalid_target')
    expect((await s.token({ grant_type: 'password' })).body.error).toBe('unsupported_grant_type')
    expect((await s.token(exchange(c))).status).toBe(200)
  })

  it('refuses an expired code', async () => {
    let t = Date.now()
    const s = await setup({ now: () => new Date(t) })
    const c = await code(s)
    t += 61_000
    expect((await s.token(exchange(c))).body.error).toBe('invalid_grant')
  })

  it('does not take one token type for another', async () => {
    const s = await setup()
    const t = await s.connect()
    expect((await s.token({ grant_type: 'refresh_token', refresh_token: t.access_token })).body.error).toBe(
      'invalid_grant',
    )
    expect((await s.mcp(t.refresh_token, 'tools/list')).status).toBe(401)
    expect((await s.token(exchange(t.access_token))).body.error).toBe('invalid_grant')
  })

  it('accepts form-encoded requests only', async () => {
    const s = await setup()
    const res = await s.req('/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    })
    expect(res.status).toBe(400)
  })
})

describe('tokens and RC sessions', () => {
  it('a token for another audience or issuer is refused', async () => {
    const s = await setup()
    const other = await seal(
      { keys: s.keys, issuer: PUBLIC, audience: 'https://other.example/mcp', now: () => new Date() },
      'access',
      { client_id: CLAUDE, scope: '', access: 'read', sub: 'x', rc_token: 'rc-1' },
    )
    expect((await s.mcp(other, 'tools/list')).status).toBe(401)
  })

  it('an expired access token gets 401 invalid_token', async () => {
    let t = Date.now()
    const s = await setup({ now: () => new Date(t) })
    const tokens = await s.connect()
    t += 901_000
    const res = await s.mcp(tokens.access_token, 'tools/list')
    expect(res.status).toBe(401)
    expect(res.headers.get('WWW-Authenticate')).toContain('invalid_token')
  })

  it('an RC 401 during a tool call becomes HTTP 401; refresh then signs in to RC again', async () => {
    const s = await setup()
    const t = await s.connect()
    s.rc.live.clear() // RC ended the session
    const res = await s.mcp(t.access_token, 'tools/call', { name: 'list_rooms', arguments: {} })
    expect(res.status).toBe(401)
    expect(res.headers.get('WWW-Authenticate')).toContain('error="invalid_token"')

    const r = await s.token({ grant_type: 'refresh_token', refresh_token: t.refresh_token })
    expect(r.status).toBe(200)
    expect(s.rc.signIns).toHaveLength(2)
    const call = await s.mcp(r.body.access_token, 'tools/call', { name: 'list_rooms', arguments: {} })
    expect(call.status).toBe(200)
  })

  it('refresh falls back to invalid_grant when the RC login no longer works', async () => {
    const s = await setup()
    const t = await s.connect()
    s.rc.live.clear()
    s.rc.setPassword('changed')
    const r = await s.token({ grant_type: 'refresh_token', refresh_token: t.refresh_token })
    expect(r.status).toBe(400)
    expect(r.body.error).toBe('invalid_grant')
  })

  it('opens tokens sealed with the previous key after a rotation', async () => {
    const old = await setup({ key: KEY })
    const t = await old.connect()
    const rotated = await serverKeys(KEY2, KEY)
    const scope = { keys: rotated, issuer: PUBLIC, audience: MCP, now: () => new Date() }
    expect((await open(scope, 'refresh', t.refresh_token!))?.rc_user).toBe(USER)
    const noPrevious = await serverKeys(KEY2)
    expect(await open({ ...scope, keys: noPrevious }, 'refresh', t.refresh_token!)).toBeUndefined()
  })

  it('refuses a short server key', async () => {
    await expect(serverKeys('c2hvcnQ')).rejects.toThrow(/at least 32 bytes/)
  })
})

describe('client IP and access log', () => {
  it('takes the address the trusted proxies saw, never what the client claims', () => {
    expect(clientIp('10.0.0.5', undefined, 1)).toBe('10.0.0.5')
    expect(clientIp('10.0.0.5', '203.0.113.7', 0)).toBe('10.0.0.5')
    expect(clientIp('10.0.0.5', '203.0.113.7', 1)).toBe('203.0.113.7')
    expect(clientIp('10.0.0.5', '6.6.6.6, 203.0.113.7', 1)).toBe('203.0.113.7') // spoofed entry on the left
    expect(clientIp('10.0.0.5', '6.6.6.6, 203.0.113.7, 10.0.0.9', 2)).toBe('203.0.113.7')
    expect(clientIp('10.0.0.5', '203.0.113.7', 5)).toBe('203.0.113.7')
  })

  it('logs one line per request with the client IP and no query string; login events carry the IP', async () => {
    const s = await setup()
    const { cookie } = await s.authorize()
    await s.req('/login', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'X-Forwarded-For': '6.6.6.6, 198.51.100.4',
        Cookie: cookie!,
      },
      body: new URLSearchParams({ username: USER, password: 'wrong', action: 'allow' }),
    })
    const events = s.lines.map((l) => JSON.parse(l))
    const auth = events.find((e) => e.event === 'http' && e.path === '/authorize')
    expect(auth).toMatchObject({ method: 'GET', status: 200 })
    expect(JSON.stringify(auth)).not.toContain('code_challenge')
    expect(events.find((e) => e.event === 'oauth_login_rejected')).toMatchObject({ ip: '198.51.100.4' })
    expect(events.find((e) => e.event === 'http' && e.path === '/login')).toMatchObject({ ip: '198.51.100.4' })
  })

  it('refuses oversized form posts', async () => {
    const s = await setup()
    const res = await s.req('/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=refresh_token&refresh_token=' + 'a'.repeat(20_000),
    })
    expect(res.status).toBe(413)
  })
})

describe('identifiable upstream traffic and correlated logs', () => {
  it('tells RC who we are, which client and which IP; every line of a request shares its id', async () => {
    const s = await setup()
    const tokens = await s.connect()
    const login = s.rc.headers[0]!
    expect(login.get('User-Agent')).toMatch(
      /^realtycalendar-web-mcp\/[\d.]+ \(\+https:\/\/rc\.example\.test; via claude\.ai\)$/,
    )
    expect(login.get('X-Forwarded-For')).toBe('10.0.0.5') // the test's socket address, no proxy header sent

    const res = await s.req('/mcp', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'Mcp-Protocol-Version': '2025-06-18',
        Authorization: `Bearer ${tokens.access_token}`,
        'X-Forwarded-For': '6.6.6.6, 203.0.113.10',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'list_rooms', arguments: {} },
      }),
    })
    const requestId = res.headers.get('X-Request-Id')!
    expect(requestId).toMatch(/^[a-z]{12}$/)
    const rcCall = s.rc.headers.at(-1)!
    expect(rcCall.get('X-Request-Id')).toBe(requestId)
    expect(rcCall.get('X-Forwarded-For')).toBe('203.0.113.10')

    const events = s.lines.map((l) => JSON.parse(l))
    const mine = events.filter((e) => e.request_id === requestId)
    expect(mine.map((e) => e.event)).toEqual(expect.arrayContaining(['rc_request', 'tool', 'http']))
    for (const e of mine) expect(e).toMatchObject({ ip: '203.0.113.10', client: 'claude.ai' })
    const account = mine[0].account
    expect(account).toMatch(/^[a-z]{10}$/)
    expect(events.find((e) => e.event === 'oauth_login').account).toBe(account)
    expect(JSON.stringify(events)).not.toContain(USER)
  })
})
