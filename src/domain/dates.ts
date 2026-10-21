// Hotel-local calendar dates as 'YYYY-MM-DD' strings. No clock reads here: `now` is passed in.

const ISO = /^\d{4}-\d{2}-\d{2}$/
const WEEKDAYS = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'] as const
const DAY_MS = 86_400_000

export function isDate(s: string): boolean {
  if (!ISO.test(s)) return false
  const d = new Date(`${s}T00:00:00Z`)
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s
}

/** Today's date in the hotel's time zone. */
export function todayIn(now: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now)
}

export function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10)
}

/** Nights from check_in to check_out (exclusive). */
export function nightsBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS)
}

/** Russian short weekday: "пн" … "вс". */
export function weekday(date: string): string {
  return WEEKDAYS[new Date(`${date}T00:00:00Z`).getUTCDay()]!
}

/** Every night in [from, to). */
export function nights(from: string, to: string): string[] {
  const out: string[] = []
  for (let d = from; d < to; d = addDays(d, 1)) out.push(d)
  return out
}

/** Max of two ISO dates / min of two ISO dates (string comparison works for YYYY-MM-DD). */
export const maxDate = (a: string, b: string) => (a > b ? a : b)
export const minDate = (a: string, b: string) => (a < b ? a : b)
