import { describe, expect, it } from 'vitest'
import { redact, redactString } from '../../src/domain/redact.js'

describe('redact', () => {
  it('removes phones, e-mails and secrets from strings', () => {
    expect(redactString('call +7 (916) 123-45-67 or a.b@example.com, token abc123XYZ', ['abc123XYZ'])).toBe(
      'call [phone] or [email], token [secret]',
    )
  })
  it('keeps dates and ids', () => {
    expect(redactString('booking 810000208 on 2055-01-20 2055-01-23')).toBe(
      'booking 810000208 on 2055-01-20 2055-01-23',
    )
    expect(redactString('89161234567')).toBe('[phone]')
  })
  it('masks PII keys deeply', () => {
    expect(redact({ booking_id: 1, guest: { fio: 'Иван Петров', phone: null }, list: [{ notes: 'x' }] })).toEqual({
      booking_id: 1,
      guest: { fio: '[redacted]', phone: null },
      list: [{ notes: '[redacted]' }],
    })
  })
})
