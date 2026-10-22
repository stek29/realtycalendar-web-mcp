// Audit log of confirmed writes (architecture.md "Write path", plan-m3.md §4). Portable: the sink is passed in.

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
