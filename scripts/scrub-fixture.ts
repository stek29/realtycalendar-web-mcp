// Scrubs a recorded RC response for test/fixtures: guest names, phones, e-mails, notes, OTA field values, audit
// details and account contacts are replaced; ids, dates, statuses and money are kept.
// Legacy contact-redaction helper only: do not use its output as publication-ready anonymized data.
// Usage: npx tsx scripts/scrub-fixture.ts <out-dir> <in.json>… (one run shares fake names across files)
import { readFileSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'

/** Fake names allowed in fixtures (test/unit/fixtures-pii.test.ts rejects any other Cyrillic full name). */
export const FAKE_NAMES = [
  'Иван Иванов',
  'Анна Петрова',
  'Пётр Сидоров',
  'Мария Смирнова',
  'Олег Кузнецов',
  'Елена Попова',
  'Сергей Васильев',
  'Ольга Новикова',
  'Дмитрий Морозов',
  'Татьяна Волкова',
  'Андрей Соколов',
  'Наталья Лебедева',
]

const NAME_KEYS = new Set(['fio', 'client_name', 'full_name'])
const PHONE_KEYS = new Set(['phone', 'client_phone', 'additional_phone', 'telephone'])
const EMAIL_KEYS = new Set(['email', 'unconfirmed_email', 'owner_email_phone'])
const TEXT_KEYS = new Set([
  'notes',
  'note',
  'client_notes',
  'short_notes',
  'guest_notes',
  'address',
  'description',
  'auto_text',
  'remote_address',
  'first_name',
  'last_name',
  'inn',
  'kpp',
  'site',
  'avatar_url',
  'city',
  'booking_widget_title',
])
/** Arrays whose items carry free text we don't need in fixtures. */
const DROP_KEYS = new Set(['changes', 'photos'])
/** OTA fields whose values are kept (no personal data). */
const KEEP_EXTERNAL = new Set(['Статус', 'Дата бронирования', 'Валюта', 'Ночные?'])

/** Returns a scrub function; fake names, phones and e-mails stay consistent across all calls of one scrubber. */
export function makeScrubber(): (data: unknown) => unknown {
  const names = new Map<string, string>()
  const phones = new Map<string, string>()
  const emails = new Map<string, string>()
  const fake = (map: Map<string, string>, real: string, make: (n: number) => string) => {
    if (!map.has(real)) map.set(real, make(map.size))
    return map.get(real)!
  }
  const fakeName = (s: string) => fake(names, s, (n) => FAKE_NAMES[n % FAKE_NAMES.length]!)
  const fakePhone = (s: string) => fake(phones, s.replace(/\D/g, ''), (n) => `+7999000${String(n).padStart(4, '0')}`)
  const fakeEmail = (s: string) => fake(emails, s.toLowerCase(), (n) => `guest${n}@example.com`)

  const walk = (v: unknown, key = ''): unknown => {
    if (Array.isArray(v)) return DROP_KEYS.has(key) ? [] : v.map((x) => walk(x, key))
    if (v && typeof v === 'object') {
      const o = { ...(v as Record<string, unknown>) }
      // external.fields: [{title, value, color}] — values are OTA data (guest name, booking number, notes …)
      if (key === 'fields' && typeof o.title === 'string' && 'value' in o) {
        const keep = KEEP_EXTERNAL.has(o.title)
        return { ...o, value: keep ? o.value : o.value == null ? null : `[${o.title}]` }
      }
      // The agency's title is the hotel's (often a person's) name.
      if ((key === 'agency' || key === 'agencies') && typeof o.title === 'string') o.title = 'Тестовый отель'
      return Object.fromEntries(Object.entries(o).map(([k, x]) => [k, walk(x, k)]))
    }
    if (typeof v !== 'string' || v === '') return v
    if (NAME_KEYS.has(key)) return fakeName(v)
    if (PHONE_KEYS.has(key)) return fakePhone(v)
    if (EMAIL_KEYS.has(key)) return fakeEmail(v)
    if (TEXT_KEYS.has(key)) return `[${key}]`
    return v
  }
  return (data) => walk(data)
}

if (process.argv[1]?.endsWith('scrub-fixture.ts')) {
  const [outDir, ...inputs] = process.argv.slice(2)
  if (!outDir || !inputs.length) {
    console.error('usage: scrub-fixture.ts <out-dir> <in.json>…')
    process.exit(1)
  }
  const scrub = makeScrubber()
  for (const input of inputs) {
    const data = scrub(JSON.parse(readFileSync(input, 'utf8')))
    writeFileSync(join(outDir, basename(input)), JSON.stringify(data, null, 1) + '\n')
  }
}
