export type ErrorCode =
  | 'AUTH'
  | 'NOT_FOUND'
  | 'DELETED'
  | 'AMBIGUOUS'
  | 'UNKNOWN_NAME'
  | 'ROOM_NOT_IN_CATEGORY'
  | 'OCCUPIED'
  | 'INVALID_DATES'
  | 'RANGE_TOO_LONG'
  | 'PREVIEW_STALE'
  | 'ACCESS_DENIED'
  | 'SITE_BOOKING'
  | 'VALIDATION'
  | 'RC_SCHEMA_DRIFT'
  | 'RC_ERROR'

/** A tool error (spec §1 Errors): becomes an MCP result with isError: true. */
export class ToolError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly hint?: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message)
    this.name = 'ToolError'
  }

  toJSON(): Record<string, unknown> {
    return { error: this.code, message: this.message, ...(this.hint ? { hint: this.hint } : {}), ...this.details }
  }
}
