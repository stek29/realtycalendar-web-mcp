// Local audit log for stdio (plan-m3.md §4): one JSONL file per day, directory 0700, files 0600, 30 days kept.
import { appendFile, chmod, mkdir, readdir, unlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { AuditEntry, AuditSink } from '../audit.js'

const APP = 'realtycalendar-web-mcp'
const KEEP_DAYS = 30
const FILE = /^audit-(\d{4}-\d{2}-\d{2})\.jsonl$/

/** RC_AUDIT_DIR, else the platform's usual place for app logs/state. */
export function auditDir(env: NodeJS.ProcessEnv, platform = process.platform, home = homedir()): string {
  if (env.RC_AUDIT_DIR) return env.RC_AUDIT_DIR
  if (platform === 'darwin') return join(home, 'Library', 'Logs', APP)
  if (platform === 'win32') return join(env.LOCALAPPDATA ?? join(home, 'AppData', 'Local'), APP)
  return join(env.XDG_STATE_HOME ?? join(home, '.local', 'state'), APP)
}

/** Creates the directory (0700) and deletes day files older than 30 days. */
export async function fileAuditSink(dir: string, now = new Date()): Promise<AuditSink> {
  await mkdir(dir, { recursive: true, mode: 0o700 })
  await chmod(dir, 0o700)
  const cutoff = new Date(now.getTime() - KEEP_DAYS * 86_400_000).toISOString().slice(0, 10)
  for (const name of await readdir(dir)) {
    const day = name.match(FILE)?.[1]
    if (day && day < cutoff) await unlink(join(dir, name))
  }
  return {
    async write(entry: AuditEntry) {
      const file = join(dir, `audit-${entry.time.slice(0, 10)}.jsonl`)
      await appendFile(file, JSON.stringify(entry) + '\n', { mode: 0o600 })
      await chmod(file, 0o600)
    },
  }
}
