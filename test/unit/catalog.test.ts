import { describe, expect, it } from 'vitest'
import { memoryCache } from '../../src/cache.js'
import { parseConfig } from '../../src/config.js'
import { makeContext } from '../../src/context.js'
import { resolveCategories, resolveRoom, resolveSources, shortTitle } from '../../src/domain/catalog.js'
import { fakeRc } from '../fake-rc.js'

async function catalog() {
  const rc = fakeRc()
  const ctx = makeContext('t', parseConfig({}), memoryCache(), { fetch: rc.fetch })
  return { catalog: await ctx.catalog(), ctx, rc }
}

describe('catalog', () => {
  it('loads 9 categories and 18 real rooms', async () => {
    const { catalog: c } = await catalog()
    expect(c.categories).toHaveLength(9)
    expect(c.categories.flatMap((x) => x.rooms)).toHaveLength(18)
    expect(c.categories.filter((x) => x.singleUnit).map((x) => x.number)).toEqual(['04', '08', '09'])
    expect(c.categories.find((x) => x.number === '05')).toMatchObject({ capacity: 2, maxGuests: 3 })
    expect(c.currency).toBe('₽')
  })

  it('caches the catalog', async () => {
    const { ctx, rc } = await catalog()
    const n = rc.calls.length
    await ctx.catalog()
    expect(rc.calls.length).toBe(n)
    await ctx.catalog({ refresh: true })
    expect(rc.calls.length).toBeGreaterThan(n)
  })

  it('shortens titles', () => {
    expect(shortTitle('01. Стандартный двухместный номер с двуспальной кроватью ', '01')).toBe(
      '01 Стандартный двухместный',
    )
    expect(shortTitle('08. Семейный номер Делюкс', '08')).toBe('08 Семейный Делюкс')
    expect(shortTitle('04. Двухместный коттедж', '04')).toBe('04 Двухместный коттедж')
  })

  it('resolves rooms', async () => {
    const { catalog: c } = await catalog()
    expect(resolveRoom(c, '22-й')).toMatchObject({ title: '22', categoryId: 810000050 })
    expect(resolveRoom(c, '810000029').title).toBe('5')
    expect(() => resolveRoom(c, '99')).toThrow(expect.objectContaining({ code: 'UNKNOWN_NAME' }))
  })

  it('resolves categories with Russian endings', async () => {
    const { catalog: c } = await catalog()
    const nums = (q: string) => resolveCategories(c, q).map((x) => x.number)
    expect(nums('двухместную улучшенную')).toEqual(['02', '03'])
    expect(nums('улучшенный двуспальной')).toEqual(['02'])
    expect(nums('коттедж')).toEqual(['04'])
    expect(nums('02')).toEqual(['02'])
    expect(nums('семейный')).toEqual(['08', '09'])
    expect(() => nums('люкс')).toThrow(expect.objectContaining({ code: 'UNKNOWN_NAME' }))
  })

  it('resolves sources in Latin and Cyrillic', async () => {
    const { catalog: c } = await catalog()
    const titles = (q: string) => resolveSources(c, q).map((s) => s.title)
    expect(titles('островок')).toEqual(['Ostrovok.ru'])
    expect(titles('Островка')).toEqual(['Ostrovok.ru'])
    expect(titles('ostrovok')).toEqual(['Ostrovok.ru'])
    expect(titles('яндекс')).toEqual(['Яндекс Путешествия'])
    expect(titles('суточно')).toEqual(['Sutochno.ru'])
    expect(titles('букинг')).toEqual(['Booking.com'])
  })
})
