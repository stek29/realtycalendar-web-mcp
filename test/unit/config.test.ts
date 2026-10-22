import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { accessAllows, parseConfig } from '../../src/config.js'
import { memoryCache } from '../../src/cache.js'
import { VERSION } from '../../src/context.js'

describe('parseConfig', () => {
  it('defaults to read and Europe/Moscow with a random key', () => {
    const c = parseConfig({})
    expect(c.access).toBe('read')
    expect(c.timezone).toBe('Europe/Moscow')
    expect(c.confirmKey.length).toBe(32)
  })
  it('rejects unknown access levels and time zones', () => {
    expect(() => parseConfig({ RC_ACCESS: 'admin' })).toThrow(/RC_ACCESS/)
    expect(() => parseConfig({ RC_TIMEZONE: 'Mars/Base' })).toThrow(/RC_TIMEZONE/)
  })
  it('protects booking-site bookings unless RC_SITE_BOOKINGS=allow', () => {
    expect(parseConfig({}).siteBookings).toBe('protect')
    expect(parseConfig({ RC_SITE_BOOKINGS: 'allow' }).siteBookings).toBe('allow')
    expect(() => parseConfig({ RC_SITE_BOOKINGS: 'yes' })).toThrow(/RC_SITE_BOOKINGS/)
  })
  it('orders access levels', () => {
    expect(accessAllows('read', 'read')).toBe(true)
    expect(accessAllows('read', 'book')).toBe(false)
    expect(accessAllows('full', 'edit')).toBe(true)
  })
})

describe('memoryCache', () => {
  it('expires entries', async () => {
    let t = 0
    const c = memoryCache(() => t)
    await c.set('k', 1, 10)
    expect(await c.get('k')).toBe(1)
    t = 10_000
    expect(await c.get('k')).toBeUndefined()
  })
})

describe('VERSION', () => {
  it('matches package.json', () => {
    expect(VERSION).toBe(JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version)
  })
})
