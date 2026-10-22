import { mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { auditDir, fileAuditSink } from '../../src/platforms/audit-file.js'

const entry = {
  time: '2054-10-22T09:00:00.000Z',
  tool: 'update_booking',
  booking_id: 1,
  rc_user_id: 2,
  fields: ['notes'],
  result: 'ok',
  before: { id: 1 },
}

describe('file audit sink', () => {
  it('appends JSON lines to a per-day file; dir 0700, file 0600', async () => {
    const dir = join(await mkdtemp(join(tmpdir(), 'audit-')), 'logs')
    const sink = await fileAuditSink(dir)
    await sink.write(entry)
    await sink.write({ ...entry, booking_id: 3 })
    const text = await readFile(join(dir, 'audit-2054-10-22.jsonl'), 'utf8')
    expect(
      text
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l).booking_id),
    ).toEqual([1, 3])
    expect((await stat(dir)).mode & 0o777).toBe(0o700)
    expect((await stat(join(dir, 'audit-2054-10-22.jsonl'))).mode & 0o777).toBe(0o600)
  })

  it('deletes day files older than 30 days at start', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'audit-'))
    for (const f of ['audit-2054-09-01.jsonl', 'audit-2054-10-01.jsonl', 'other.txt']) await writeFile(join(dir, f), '')
    await fileAuditSink(dir, new Date('2054-10-22T09:00:00Z'))
    expect((await readdir(dir)).sort()).toEqual(['audit-2054-10-01.jsonl', 'other.txt'])
  })

  it('picks the directory per platform', () => {
    expect(auditDir({ RC_AUDIT_DIR: '/x' })).toBe('/x')
    expect(auditDir({}, 'darwin', '/h')).toBe('/h/Library/Logs/realtycalendar-web-mcp')
    expect(auditDir({ XDG_STATE_HOME: '/s' }, 'linux', '/h')).toBe('/s/realtycalendar-web-mcp')
    expect(auditDir({}, 'linux', '/h')).toBe('/h/.local/state/realtycalendar-web-mcp')
  })
})
