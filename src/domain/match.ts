// Name matching tolerant of Russian endings (spec §1 "Naming rooms, categories, sources and guests").

const DROP_WORD = /^(номер|комнат)/
const ROOM_SUFFIX = /(\d+)-?(й|я|е|ю|м|го|ой|ом|ая|ую|ые)(?=$|[^\p{L}])/gu

/** Lowercase, ё→е, drop №/"номер"/"комната", "22-й" → "22", split into words. */
export function words(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/№/g, ' ')
    .replace(ROOM_SUFFIX, '$1')
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w && !DROP_WORD.test(w))
}

const MIN_STEM = 4
const MAX_ENDING = 3

/**
 * Words match when one is a prefix of the other with ≥ 4 common characters (a stem: "улучшен" ~ "улучшенный"), or
 * when they share ≥ 4 characters and differ only in endings of ≤ 3 letters ("улучшенную" ~ "улучшенный",
 * "Петровой" ~ "Петрова"). Words shorter than 4 characters must be equal.
 */
export function wordMatches(q: string, t: string): boolean {
  if (q === t) return true
  if (q.length < MIN_STEM || t.length < MIN_STEM) return false
  let common = 0
  while (common < q.length && common < t.length && q[common] === t[common]) common++
  if (common < MIN_STEM) return false
  if (common === q.length || common === t.length) return true
  return q.length - common <= MAX_ENDING && t.length - common <= MAX_ENDING
}

/** Every query word must match some target word. An empty query matches nothing. */
export function nameMatches(query: string | string[], target: string | string[]): boolean {
  const qs = Array.isArray(query) ? query : words(query)
  const ts = Array.isArray(target) ? target : words(target)
  return qs.length > 0 && qs.every((q) => ts.some((t) => wordMatches(q, t)))
}

const TRANSLIT: Record<string, string> = {
  а: 'a',
  б: 'b',
  в: 'v',
  г: 'g',
  д: 'd',
  е: 'e',
  ж: 'zh',
  з: 'z',
  и: 'i',
  й: 'y',
  к: 'k',
  л: 'l',
  м: 'm',
  н: 'n',
  о: 'o',
  п: 'p',
  р: 'r',
  с: 's',
  т: 't',
  у: 'u',
  ф: 'f',
  х: 'kh',
  ц: 'ts',
  ч: 'ch',
  ш: 'sh',
  щ: 'sch',
  ъ: '',
  ы: 'y',
  ь: '',
  э: 'e',
  ю: 'yu',
  я: 'ya',
}

/** Latin spelling of a (normalised) Cyrillic word: "островок" → "ostrovok", "яндекс" → "yandeks". */
export function translit(word: string): string {
  return [...word].map((c) => TRANSLIT[c] ?? c).join('')
}
