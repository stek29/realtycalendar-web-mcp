import { describe, expect, it } from 'vitest'
import { nameMatches, translit, wordMatches, words } from '../../src/domain/match.js'

describe('words', () => {
  it('normalises', () => {
    expect(words('№ 22-й')).toEqual(['22'])
    expect(words('в 22-м номере')).toEqual(['в', '22'])
    expect(words('02. Двухместный улучшенный номер с двуспальной кроватью')).toEqual([
      '02',
      'двухместный',
      'улучшенный',
      'с',
      'двуспальной',
      'кроватью',
    ])
    expect(words('Ёлкина')).toEqual(['елкина'])
  })
})

describe('wordMatches', () => {
  it.each([
    ['улучшенную', 'улучшенный', true],
    ['петровой', 'петрова', true],
    ['улучшен', 'улучшенный', true],
    ['двухместную', 'двухместный', true],
    ['двуспальной', 'двуспальной', true],
    ['стандартный', 'станислав', false],
    ['22', '2', false],
    ['02', '02', true],
    ['иванов', 'иванова', true],
    ['иванов', 'ивановский', true],
  ])('%s ~ %s → %s', (q, t, expected) => {
    expect(wordMatches(q, t)).toBe(expected)
  })
})

describe('nameMatches', () => {
  const t = '02. Двухместный улучшенный номер с двуспальной кроватью'
  it('needs every query word to match', () => {
    expect(nameMatches('улучшенный двуспальной', t)).toBe(true)
    expect(nameMatches('двухместную улучшенную', t)).toBe(true)
    expect(nameMatches('02', t)).toBe(true)
    expect(nameMatches('коттедж', t)).toBe(false)
    expect(nameMatches('номер', t)).toBe(false)
  })
  it('transliterates', () => {
    expect(translit('островок')).toBe('ostrovok')
    expect(wordMatches(translit('яндекс'), 'yandex')).toBe(true)
  })
})
