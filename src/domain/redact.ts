// One redaction layer for logs and VALIDATION error details (architecture.md "Logging and privacy").

const PII_KEYS = new Set([
  'fio',
  'name',
  'guest_name',
  'client_name',
  'phone',
  'guest_phone',
  'client_phone',
  'additional_phone',
  'email',
  'guest_email',
  'notes',
  'note',
  'comment',
  'address',
  'token',
  'auth_token',
  'password',
  'x-user-token',
])

const EMAIL = /[^\s@"',;:<>()]+@[^\s@"',;:<>()]+\.[a-z]{2,}/gi
// 10+ digits with the usual separators: phones in any format; booking ids (9 digits) stay readable.
const PHONE = /\+?\d(?:[\s\-()]*\d){9,}/g
// ISO dates are cut out first so that runs of dates aren't mistaken for phone numbers.
const ISO_DATE = /(\d{4}-\d{2}-\d{2}(?:T[\d:.]+(?:Z|[+-]\d{2}:\d{2})?)?)/

export function redactString(s: string, secrets: readonly string[] = []): string {
  let out = s
  for (const secret of secrets) if (secret) out = out.split(secret).join('[secret]')
  return out
    .split(ISO_DATE)
    .map((part, i) => (i % 2 ? part : part.replace(EMAIL, '[email]').replace(PHONE, '[phone]')))
    .join('')
}

/** Deep copy with PII keys masked and phone/e-mail/secret patterns removed from every string. */
export function redact(value: unknown, secrets: readonly string[] = []): unknown {
  if (typeof value === 'string') return redactString(value, secrets)
  if (Array.isArray(value)) return value.map((v) => redact(v, secrets))
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) {
      out[k] = PII_KEYS.has(k.toLowerCase()) && v != null ? '[redacted]' : redact(v, secrets)
    }
    return out
  }
  return value
}
