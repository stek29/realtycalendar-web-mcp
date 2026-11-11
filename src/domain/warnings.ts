// Write preview warnings (spec §1 "Preview warnings") and the one-line Russian summary. Pure.
import type { BookingSummary } from './bookings.js'
import type { StayCheck } from './calendar.js'

export type WarningCode =
  | 'HOLD_OVERLAP'
  | 'CLOSED_DATES'
  | 'BOOKING_SITE'
  | 'CATEGORY_CHANGE'
  | 'PRICE_CHANGED'
  | 'PRICE_KEPT'
  | 'HAS_PAYMENTS'
  | 'PAST_DATES'
  | 'NO_GUEST_MESSAGES'
  | 'DUPLICATE'

export interface Warning {
  code: WarningCode
  message: string
  [detail: string]: unknown
}

/** The few fields that identify a booking in a warning or a conflict list. */
export const bookingBrief = (b: BookingSummary) => ({
  id: b.id,
  room: b.room,
  check_in: b.check_in,
  check_out: b.check_out,
  guest_name: b.guest_name,
})

/** HOLD_OVERLAP and CLOSED_DATES from the stay check. */
export function stayWarnings(check: StayCheck): Warning[] {
  const out: Warning[] = []
  if (check.holds.length) {
    out.push({
      code: 'HOLD_OVERLAP',
      message: 'The stay overlaps a hold (заявка). RealtyCalendar allows it; tell the user.',
      holds: check.holds.map(bookingBrief),
    })
  }
  const problems = [...check.stay_problems]
  if (check.closed_nights.length) problems.push(`room closed on ${check.closed_nights.join(', ')}`)
  if (problems.length) {
    out.push({
      code: 'CLOSED_DATES',
      message: 'The stay breaks the booking rules. RealtyCalendar will save it anyway; tell the user.',
      problems,
    })
  }
  return out
}

export const pastDates = (checkIn: string, today: string): Warning[] =>
  checkIn < today
    ? [{ code: 'PAST_DATES', message: `check_in ${checkIn} is before today (${today}); check the year` }]
    : []

export const bookingSite = (platform: string, what: string): Warning => ({
  code: 'BOOKING_SITE',
  message: `Booking from ${platform}: ${what} is not sent to ${platform}; the user must do it there too.`,
})

export const hasPayments = (paid: number, currency: string): Warning => ({
  code: 'HAS_PAYMENTS',
  message: `The booking has payments (${money(paid, currency)} net); they stay in the money history.`,
  paid,
})

const MONTHS = [
  'января',
  'февраля',
  'марта',
  'апреля',
  'мая',
  'июня',
  'июля',
  'августа',
  'сентября',
  'октября',
  'ноября',
  'декабря',
]

/** "7–9 ноября", "30 декабря – 3 января 2055"; the year only when it isn't today's. */
export function dateRange(from: string, to: string, today: string): string {
  const [fy, fm, fd] = from.split('-').map(Number) as [number, number, number]
  const [ty, tm, td] = to.split('-').map(Number) as [number, number, number]
  const year = ty !== Number(today.slice(0, 4)) || fy !== ty ? ` ${ty}` : ''
  if (fy === ty && fm === tm) return `${fd}–${td} ${MONTHS[tm - 1]}${year}`
  const fromYear = fy !== ty ? ` ${fy}` : ''
  return `${fd} ${MONTHS[fm - 1]}${fromYear} – ${td} ${MONTHS[tm - 1]}${year}`
}

/** "8 600 ₽" */
export const money = (n: number, currency: string) =>
  `${String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ')} ${currency}`

/** "22, 7–9 ноября, Анна Петрова, 8 600 ₽" — room, else category. */
export function bookingLine(
  b: Omit<BookingSummary, 'id'>,
  currency: string,
  today: string,
  hideGuestPii = false,
): string {
  return [
    b.room ?? b.category,
    dateRange(b.check_in, b.check_out, today),
    hideGuestPii ? '—' : (b.guest_name ?? '—'),
    money(b.total, currency),
  ].join(', ')
}
