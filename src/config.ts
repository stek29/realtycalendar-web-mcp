export const ACCESS_LEVELS = ['read', 'book', 'edit', 'full'] as const
export type Access = (typeof ACCESS_LEVELS)[number]

export interface Config {
  access: Access
  timezone: string
  confirmKey: Uint8Array
  rcBaseUrl: string
}

export const RC_BASE_URL = 'https://realtycalendar.ru/v2/'

/** Reads RC_ACCESS, RC_TIMEZONE, RC_CONFIRM_KEY from an env-like record. Throws on invalid values. */
export function parseConfig(env: Record<string, string | undefined>): Config {
  const access = (env.RC_ACCESS?.trim() || 'read') as Access
  if (!ACCESS_LEVELS.includes(access)) {
    throw new Error(`RC_ACCESS must be one of ${ACCESS_LEVELS.join(', ')}; got "${env.RC_ACCESS}"`)
  }
  const timezone = env.RC_TIMEZONE?.trim() || 'Europe/Moscow'
  try {
    new Intl.DateTimeFormat('en', { timeZone: timezone })
  } catch {
    throw new Error(`RC_TIMEZONE is not a valid IANA time zone: "${timezone}"`)
  }
  const key = env.RC_CONFIRM_KEY
  const confirmKey = key ? new TextEncoder().encode(key) : crypto.getRandomValues(new Uint8Array(32))
  return { access, timezone, confirmKey, rcBaseUrl: RC_BASE_URL }
}

/** True when a tool of `level` is allowed under `access`. */
export function accessAllows(access: Access, level: Access): boolean {
  return ACCESS_LEVELS.indexOf(level) <= ACCESS_LEVELS.indexOf(access)
}
