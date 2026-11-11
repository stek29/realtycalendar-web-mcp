// Presentation only: never mask RC responses used for matching, confirmation plans or PUT bodies.

const normalize = (s: string) =>
  s
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^\p{L}\p{N}]/gu, '')

/** Known structured guest field names and RC/booking-site labels. No detection in arbitrary text. */
const GUEST_FIELDS = new Set(
  [
    'guest_name',
    'guest_phone',
    'client_name',
    'client_phone',
    'fio',
    'phone',
    'additional_phone',
    'first_name',
    'last_name',
    'full_name',
    'telephone',
    'Гость',
    'ФИО',
    'ФИО гостя',
    'Имя',
    'Фамилия',
    'Отчество',
    'Имя гостя',
    'Фамилия гостя',
    'Отчество гостя',
    'Полное имя гостя',
    'Телефон',
    'Телефон гостя',
    'Номер телефона',
    'Дополнительный телефон',
    'Guest name',
    'Full guest name',
    'Guest phone',
    'Guest phone number',
    'Phone number',
  ].map(normalize),
)

const isGuestField = (key: string) => GUEST_FIELDS.has(normalize(key))

/** Schema-preserving copy of an MCP result (including nested warnings, conflicts and error previews). */
export function hideGuestPii(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(hideGuestPii)
  if (!value || typeof value !== 'object') return value
  const object = value as Record<string, unknown>
  const guestChange = typeof object.field === 'string' && isGuestField(object.field)
  return Object.fromEntries(
    Object.entries(object).map(([key, v]) => {
      // RC history and write changes use {field, from, to}.
      if (guestChange && (key === 'from' || key === 'to')) return [key, null]
      // Booking-site fields are a string-valued record, not nullable guest fields.
      if (key === 'fields' && v && typeof v === 'object' && !Array.isArray(v)) {
        return [
          key,
          Object.fromEntries(
            Object.entries(v).map(([label, content]) => [label, isGuestField(label) ? '[hidden]' : content]),
          ),
        ]
      }
      // Other strings, including notes, staff names and email addresses, are deliberately untouched.
      return [key, isGuestField(key) && v != null ? null : hideGuestPii(v)]
    }),
  )
}
