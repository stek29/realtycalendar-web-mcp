import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { FAKE_NAMES } from '../../scripts/scrub-fixture.js'
import * as schemas from '../../src/upstream/schemas.js'
import { fixture } from '../fake-rc.js'

const DIR = join(import.meta.dirname, '..', 'fixtures')

/** Every string value in the fixtures with the key it sits under. */
function strings(v: unknown, key = '', out: [string, string][] = []): [string, string][] {
  if (typeof v === 'string') out.push([key, v])
  else if (Array.isArray(v)) v.forEach((x) => strings(x, key, out))
  else if (v && typeof v === 'object') Object.entries(v).forEach(([k, x]) => strings(x, k, out))
  return out
}

describe('fixture hygiene', () => {
  const values = readdirSync(DIR).flatMap((f) => strings(JSON.parse(readFileSync(join(DIR, f), 'utf8'))))

  it('has only fake phones', () => {
    const phones = values.flatMap(
      ([, v]) => v.match(/(?<![\d/])(?:\+7|8)[\s-]?\(?\d{3}\)?[\s-]?\d{3}[\s-]?\d{2}[\s-]?\d{2}(?!\d)/g) ?? [],
    )
    expect(phones.filter((p) => !p.startsWith('+7999000'))).toEqual([])
  })
  it('has only example.com e-mails', () => {
    const emails = values.flatMap(([, v]) => v.match(/[\w.+-]+@[\w-]+\.[\w.-]+/g) ?? [])
    expect(emails.filter((e) => !e.endsWith('@example.com'))).toEqual([])
  })
  it('has no Cyrillic full names except the fake ones and source names', () => {
    const sources = fixture<schemas.Info>('info').agency.sources_list.map((s) => s.title)
    const names = values
      .filter(([k]) => k !== 'title') // category, source and field titles
      .flatMap(([, v]) => v.match(/[А-ЯЁ][а-яё]+ [А-ЯЁ][а-яё]+/g) ?? [])
    expect(names.filter((n) => !FAKE_NAMES.includes(n) && !sources.includes(n))).toEqual([])
  })
})

describe('fixtures match the RC schemas', () => {
  it.each([
    ['info', schemas.InfoSchema],
    ['apartments', schemas.ApartmentsSchema],
    ['apartment_info_810000052', schemas.ApartmentInfoSchema],
    ['grid_booked_request', schemas.GridSchema],
    ['grid_canceled', schemas.GridSchema],
    ['stay_rules', schemas.StayRulesSchema],
    ['booking_810000162', schemas.BookingSchema],
    ['payments_810000162', schemas.PaymentsSchema],
  ] as const)('%s', (name, schema) => {
    expect(schema.safeParse(fixture(name)).success).toBe(true)
  })
})
