import { describe, expect, it } from 'vitest'
import { login, logout, type LoginIo } from '../../src/cli/login.js'

const OPTS = { baseUrl: 'https://rc.test/v2/', userAgent: 'test' }

function fakeFetch(status: number, body: unknown) {
  const calls: { method: string; url: string; headers: Record<string, string>; body?: string }[] = []
  const fetch = (async (input: URL, init: RequestInit) => {
    calls.push({
      method: init.method!,
      url: String(input),
      headers: init.headers as Record<string, string>,
      body: init.body as string | undefined,
    })
    return new Response(JSON.stringify(body), { status })
  }) as unknown as typeof globalThis.fetch
  return { fetch, calls }
}

function io(answers: string[]) {
  const out: string[] = []
  const err: string[] = []
  const hidden: boolean[] = []
  const value: LoginIo = {
    ask: async (_q, h = false) => (hidden.push(h), answers.shift() ?? ''),
    out: (s) => out.push(s),
    err: (s) => err.push(s),
  }
  return { io: value, out, err, hidden }
}

describe('login', () => {
  it('signs in without a token header and prints only the token on stdout', async () => {
    const f = fakeFetch(200, { auth_token: 'tok123', success: true })
    const t = io(['user@example.com', 's3cret'])
    expect(await login(t.io, { ...OPTS, fetch: f.fetch })).toBe(0)
    expect(t.hidden).toEqual([false, true])
    expect(t.out).toEqual(['tok123'])
    expect(t.err.join('\n')).not.toContain('s3cret')
    expect(f.calls[0]).toMatchObject({ method: 'POST', url: 'https://rc.test/v2/sign_in' })
    expect(JSON.parse(f.calls[0]!.body!)).toEqual({ username: 'user@example.com', password: 's3cret' })
    expect(f.calls[0]!.headers['X-User-Token']).toBeUndefined()
  })

  it('refused sign-in → exit 1, no token, no password in messages', async () => {
    const f = fakeFetch(401, { error: 'bad' })
    const t = io(['user', 's3cret'])
    expect(await login(t.io, { ...OPTS, fetch: f.fetch })).toBe(1)
    expect(t.out).toEqual([])
    expect(t.err.join('\n')).toMatch(/refused/)
    expect(t.err.join('\n')).not.toContain('s3cret')
  })

  it('empty input → exit 1 without calling RC', async () => {
    const f = fakeFetch(200, {})
    expect(await login(io(['', '']).io, { ...OPTS, fetch: f.fetch })).toBe(1)
    expect(f.calls).toEqual([])
  })
})

describe('logout', () => {
  it('DELETE sign_in with the token', async () => {
    const f = fakeFetch(200, { success: true })
    expect(await logout('tok123', () => {}, { ...OPTS, fetch: f.fetch })).toBe(0)
    expect(f.calls[0]).toMatchObject({ method: 'DELETE', url: 'https://rc.test/v2/sign_in' })
    expect(f.calls[0]!.headers['X-User-Token']).toBe('tok123')
  })

  it('no token → exit 1; an already dead token → exit 0', async () => {
    expect(await logout(undefined, () => {}, OPTS)).toBe(1)
    expect(await logout('dead', () => {}, { ...OPTS, fetch: fakeFetch(401, {}).fetch })).toBe(0)
  })
})
