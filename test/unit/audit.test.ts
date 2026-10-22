import { describe, expect, it } from 'vitest'
import { streamAudit } from '../../src/audit.js'
import { parseConfig } from '../../src/config.js'

const entry = {
  time: '2054-10-22T09:00:00.000Z',
  tool: 'update_booking',
  booking_id: 1,
  rc_user_id: 2,
  fields: ['notes'],
  result: 'ok',
  before: { id: 1, client: { fio: 'Анна Петрова' } },
}

describe('audit lines', () => {
  it('summary (default): one JSON line without the booking body', async () => {
    const lines: string[] = []
    await streamAudit((l) => lines.push(l), parseConfig({}).audit).write(entry)
    expect(lines).toHaveLength(1)
    const { before: _b, ...rest } = entry
    expect(JSON.parse(lines[0]!)).toEqual({ event: 'audit', ...rest })
    expect(lines[0]).not.toContain('Анна')
  })

  it('full: adds the booking as it was', async () => {
    const lines: string[] = []
    await streamAudit((l) => lines.push(l), 'full').write(entry)
    expect(JSON.parse(lines[0]!).before).toEqual(entry.before)
  })

  it('RC_AUDIT accepts only summary and full', () => {
    expect(parseConfig({ RC_AUDIT: 'full' }).audit).toBe('full')
    expect(() => parseConfig({ RC_AUDIT: 'file' })).toThrow(/RC_AUDIT/)
  })
})
