// The hotel's categories, rooms and sources, and name → id resolution (spec §1 "Naming …").
import { ToolError } from './errors.js'
import { nameMatches, translit, words } from './match.js'
import type { Apartments, Info } from '../upstream/schemas.js'

export interface Room {
  id: number
  title: string
  categoryId: number
}

export interface Category {
  id: number
  number: string
  title: string
  shortTitle: string
  /** No rooms: the category itself is one bookable unit. */
  singleUnit: boolean
  capacity: number
  maxGuests: number
  rooms: Room[]
}

export interface Source {
  id: number
  title: string
}

export interface Catalog {
  categories: Category[]
  sources: Source[]
  currency: string
}

/** Sources that are not booking sites (the hotel's own channels). */
const OWN_SOURCES = new Set(['Продление', 'Модуль бронирования', 'Корзина', 'Постоянный гость', 'Партнёрство'])

/** Russian names of sources that transliteration doesn't reach. */
const SOURCE_ALIASES: Record<string, string> = {
  букинг: 'booking',
  циан: 'cian',
  эйрбиэнби: 'airbnb',
  аирбнб: 'airbnb',
}

export function buildCatalog(apartments: Apartments, maxGuests: ReadonlyMap<number, number>, info: Info): Catalog {
  const categories = apartments.apartments
    .filter((a) => !a.archive)
    .map((a): Category => {
      // The pseudo-room id 0 ("Неразобранные") is the calendar's row for unassigned bookings, not a room.
      const rooms = a.rooms
        .filter((r) => r.id !== 0)
        .map((r) => ({ id: r.id, title: r.title.trim(), categoryId: a.id }))
      const title = a.title.trim()
      const number = title.match(/^(\d+)/)?.[1] ?? ''
      return {
        id: a.id,
        number,
        title,
        shortTitle: shortTitle(title, number),
        singleUnit: rooms.length === 0,
        capacity: Math.max(rooms.length, 1),
        maxGuests: maxGuests.get(a.id) ?? 0,
        rooms,
      }
    })
    .sort((a, b) => a.number.localeCompare(b.number, 'ru', { numeric: true }))
  return { categories, sources: info.agency.sources_list, currency: info.agency.currency }
}

/** "02. Двухместный улучшенный номер с двуспальной кроватью" → "02 Двухместный улучшенный". */
export function shortTitle(title: string, number: string): string {
  const rest = title
    .replace(/^\d+\.?\s*/, '')
    .split(/\s+с\s+/)[0]!
    .split(/\s+/)
    .filter((w) => w && w.toLowerCase() !== 'номер')
    .slice(0, 3)
    .join(' ')
  return [number, rest].filter(Boolean).join(' ')
}

export function categoryById(catalog: Catalog, id: number): Category | undefined {
  return catalog.categories.find((c) => c.id === id)
}

export function roomById(catalog: Catalog, id: number): Room | undefined {
  return catalog.categories.flatMap((c) => c.rooms).find((r) => r.id === id)
}

export function sourceTitle(catalog: Catalog, id: number | null): string | null {
  return id == null ? null : (catalog.sources.find((s) => s.id === id)?.title ?? null)
}

export function isBookingSite(catalog: Catalog, sourceId: number | null): boolean {
  const title = sourceTitle(catalog, sourceId)
  return title != null && !OWN_SOURCES.has(title)
}

/** A room by title ("22", "22-й") or id. Several or none → AMBIGUOUS / UNKNOWN_NAME. */
export function resolveRoom(catalog: Catalog, query: string): Room {
  const rooms = catalog.categories.flatMap((c) => c.rooms)
  const q = query.trim()
  const byId = /^\d+$/.test(q) ? rooms.filter((r) => String(r.id) === q) : []
  const matches = byId.length ? byId : rooms.filter((r) => words(r.title).join(' ') === words(q).join(' '))
  if (matches.length === 1) return matches[0]!
  if (matches.length > 1) {
    throw new ToolError(
      'AMBIGUOUS',
      `Several rooms are called "${query}"`,
      'Ask the user which one; show `candidates` by name',
      {
        candidates: matches.map((r) => ({
          room: r.title,
          room_id: r.id,
          category: categoryById(catalog, r.categoryId)?.shortTitle,
        })),
      },
    )
  }
  throw new ToolError('UNKNOWN_NAME', `No room "${query}"`, 'Pick from `known` or ask the user', {
    known: rooms.map((r) => r.title),
  })
}

/** Categories by id, number ("02") or title words. Read tools use all matches; none → UNKNOWN_NAME. */
export function resolveCategories(catalog: Catalog, query: string): Category[] {
  const q = query.trim()
  const qWords = words(q)
  const matches = catalog.categories.filter(
    (c) =>
      String(c.id) === q ||
      (/^\d{1,2}$/.test(q) && c.number !== '' && Number(c.number) === Number(q)) ||
      nameMatches(qWords, c.title),
  )
  if (matches.length) return matches
  throw new ToolError('UNKNOWN_NAME', `No category matches "${query}"`, 'Pick from `known` or ask the user', {
    known: catalog.categories.map((c) => c.shortTitle),
  })
}

/** Sources by name in Latin or Cyrillic ("островок", "ostrovok", "яндекс"). Read tools use all matches. */
export function resolveSources(catalog: Catalog, query: string): Source[] {
  const qWords = words(query).map((w) => SOURCE_ALIASES[w] ?? w)
  const qLatin = qWords.map(translit)
  const matches = catalog.sources.filter((s) => {
    const t = words(s.title)
    const tLatin = t.map(translit)
    return nameMatches(qWords, t) || nameMatches(qLatin, t) || nameMatches(qLatin, tLatin)
  })
  if (matches.length) return matches
  throw new ToolError('UNKNOWN_NAME', `No source matches "${query}"`, 'Pick from `known` or ask the user', {
    known: catalog.sources.map((s) => s.title),
  })
}
