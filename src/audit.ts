// Audit log of confirmed writes (architecture.md "Write path", testing.md). Portable: the sink is passed in.

export interface AuditEntry {
  time: string
  tool: string
  /** null when a create failed before RC gave an id. */
  booking_id: number | null
  /** The RC user behind the token. */
  rc_user_id: number | null
  /** Names of the RC fields written. */
  fields: string[]
  /** "ok", "already_existed" (a repeated create), or the error code. */
  result: string
  /** The full booking GET before the write, for manual undo; absent for creates. */
  before?: unknown
}

export interface AuditSink {
  write(entry: AuditEntry): Promise<void>
}

export const noAudit: AuditSink = { write: async () => {} }

export const AUDIT_DETAILS = ['summary', 'full'] as const
/** summary: no guest data; full: adds `before`, the booking as it was (guest names, phones, notes). */
export type AuditDetail = (typeof AUDIT_DETAILS)[number]

/** One JSON line per write via `write` (stdio: stderr, next to the logs, marked `event: "audit"`). */
export function streamAudit(write: (line: string) => void, detail: AuditDetail): AuditSink {
  return {
    async write({ before, ...entry }) {
      // Not passed through the log redaction: `summary` holds no guest data, and `full` is asked for explicitly.
      write(
        JSON.stringify({ event: 'audit', ...entry, ...(detail === 'full' && before !== undefined ? { before } : {}) }),
      )
    },
  }
}
