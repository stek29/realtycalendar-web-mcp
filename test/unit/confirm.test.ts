import { describe, expect, it } from 'vitest'
import { canonicalJson, signPlan, verifyPlan } from '../../src/domain/confirm.js'

const KEY = new TextEncoder().encode('test-key')
const NOW = new Date('2054-10-22T09:00:00+03:00')
const plan = {
  tool: 'update_booking',
  booking_id: 1,
  state: { updated_at: '2054-10-21T20:38:35+03:00', version: 4 },
  set: { end_date: '2055-01-24', amount: 44000 },
}
const later = (min: number) => new Date(NOW.getTime() + min * 60_000)

describe('confirm tokens', () => {
  it('canonical JSON ignores key order', () => {
    expect(canonicalJson({ b: 1, a: [{ d: 2, c: null }] })).toBe(canonicalJson({ a: [{ c: null, d: 2 }], b: 1 }))
  })

  it('round trip', async () => {
    const token = await signPlan(KEY, plan, NOW)
    expect(await verifyPlan(KEY, token, structuredClone(plan), later(14))).toBe(true)
  })

  it('expires after 15 minutes', async () => {
    const token = await signPlan(KEY, plan, NOW)
    expect(await verifyPlan(KEY, token, plan, later(16))).toBe(false)
  })

  it.each([
    ['arguments', { ...plan, set: { ...plan.set, end_date: '2055-01-25' } }],
    ['quote', { ...plan, set: { ...plan.set, amount: 45000 } }],
    ['booking state', { ...plan, state: { ...plan.state, updated_at: '2054-10-22T10:00:00+03:00' } }],
    ['tool', { ...plan, tool: 'cancel_booking' }],
  ])('a changed %s does not verify', async (_, changed) => {
    const token = await signPlan(KEY, plan, NOW)
    expect(await verifyPlan(KEY, token, changed, NOW)).toBe(false)
  })

  it('another key does not verify', async () => {
    const token = await signPlan(KEY, plan, NOW)
    expect(await verifyPlan(new TextEncoder().encode('other'), token, plan, NOW)).toBe(false)
  })

  it('garbage does not verify', async () => {
    for (const t of ['', 'abc', 'a.b', 'a.b.c', '!!!.???']) expect(await verifyPlan(KEY, t, plan, NOW)).toBe(false)
  })
})
