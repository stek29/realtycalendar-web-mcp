import { AUDIT_DETAILS, type AuditDetail } from './audit.js'
export const ACCESS_LEVELS = ['read', 'book', 'edit', 'full'] as const
export type Access = (typeof ACCESS_LEVELS)[number]
export const SITE_BOOKINGS = ['protect', 'allow'] as const
/** protect: no changes to a booking-site booking that RC doesn't send to the site (D40). */
export type SiteBookings = (typeof SITE_BOOKINGS)[number]

export interface Config {
  access: Access
  timezone: string
  confirmKey: Uint8Array
  rcBaseUrl: string
  /** RC_AUDIT: how much of each write the audit line carries. */
  audit: AuditDetail
  /** RC_SITE_BOOKINGS: whether writes may change what a booking site sold (dates, category, status, price). */
  siteBookings: SiteBookings
  /** Hide known guest-name and phone fields in MCP responses, without changing upstream data. */
  hideGuestPii: boolean
}

export const RC_BASE_URL = 'https://realtycalendar.ru/v2/'

/** Reads server settings from an env-like record. Throws on invalid values. */
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
  const audit = (env.RC_AUDIT?.trim() || 'summary') as AuditDetail
  if (!AUDIT_DETAILS.includes(audit)) {
    throw new Error(`RC_AUDIT must be one of ${AUDIT_DETAILS.join(', ')}; got "${env.RC_AUDIT}"`)
  }
  const siteBookings = (env.RC_SITE_BOOKINGS?.trim() || 'protect') as SiteBookings
  if (!SITE_BOOKINGS.includes(siteBookings)) {
    throw new Error(`RC_SITE_BOOKINGS must be one of ${SITE_BOOKINGS.join(', ')}; got "${env.RC_SITE_BOOKINGS}"`)
  }
  const hideGuestPiiValue = env.RC_HIDE_GUEST_PII?.trim().toLowerCase() || 'false'
  if (!['true', 'false', '1', '0'].includes(hideGuestPiiValue)) {
    throw new Error('RC_HIDE_GUEST_PII must be true, false, 1 or 0')
  }
  const hideGuestPii = hideGuestPiiValue === 'true' || hideGuestPiiValue === '1'
  return { access, timezone, confirmKey, rcBaseUrl: RC_BASE_URL, audit, siteBookings, hideGuestPii }
}

/** True when a tool of `level` is allowed under `access`. */
export function accessAllows(access: Access, level: Access): boolean {
  return ACCESS_LEVELS.indexOf(level) <= ACCESS_LEVELS.indexOf(access)
}
