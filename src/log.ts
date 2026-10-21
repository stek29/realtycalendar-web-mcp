import { redact } from './domain/redact.js'

export type LogLevel = 'info' | 'warn' | 'error'

/** Structured JSON logs. Fields: tool, duration, RC endpoint + status, error code, booking ids — never bodies. */
export interface Logger {
  log(level: LogLevel, event: string, fields?: Record<string, unknown>): void
}

/** Every line goes through redact(); `secrets` (e.g. the RC token) are masked wherever they appear. */
export function jsonLogger(write: (line: string) => void, secrets: readonly string[] = []): Logger {
  return {
    log(level, event, fields = {}) {
      const entry = { time: new Date().toISOString(), level, event, ...fields }
      write(JSON.stringify(redact(entry, secrets)))
    },
  }
}

export const silentLogger: Logger = { log() {} }
