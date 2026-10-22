import { describe, expect, it } from 'vitest'
import { grade } from '../evals/run.js'

const turn = (calls: { tool: string; args: Record<string, unknown>; error?: boolean }[], answer = '') => ({
  calls: calls.map((c) => ({ error: false, ...c })),
  answer,
  cost_usd: null,
  input_tokens: 0,
  output_tokens: 0,
  ms: 0,
})

const U5a = {
  id: 'U5a',
  access: 'full',
  turns: ['…'],
  expect: [
    {
      calls: [
        { tool: 'preview_create_booking', args: { room: { re: '^22' }, check_in: '2054-11-07' } },
        { tool: 'create_booking', args: { room: { re: '^22' } }, confirm_token: true },
      ],
      answer: ['\\d{6,}'],
    },
  ],
}

describe('eval grading', () => {
  it('passes a preview then a successful write with the same arguments', () => {
    const t = turn(
      [
        { tool: 'preview_create_booking', args: { room: '22', check_in: '2054-11-07' } },
        { tool: 'create_booking', args: { check_in: '2054-11-07', room: '22', confirm_token: 'x' } },
      ],
      'Бронь 900000000',
    )
    expect(grade(U5a, [t])).toEqual([])
  })

  it('fails a write without a matching preview, a failed write, a missing answer', () => {
    const t = turn(
      [
        { tool: 'preview_create_booking', args: { room: '22', check_in: '2054-11-07' } },
        { tool: 'create_booking', args: { room: '22', check_in: '2054-11-08', confirm_token: 'x' }, error: true },
      ],
      'готово',
    )
    const f = grade(U5a, [t]).join('\n')
    expect(f).toMatch(/expected 1× create_booking/)
    expect(f).toMatch(/unexpected confirmed create_booking/)
    expect(f).toMatch(/create_booking without a preview with the same arguments/)
    expect(f).toMatch(/answer lacks/)
  })

  it('oneOf with null = absent; forbid; forbid_args; (?i) regexes; a write needs a preview', () => {
    const c = {
      id: 'X',
      access: 'full',
      turns: ['…'],
      expect: [
        {
          calls: [{ tool: 'list_bookings', args: { from: { oneOf: ['2054-10-22', null] } } }],
          answer: ['(?i)коттедж'],
          forbid: ['delete_booking'],
        },
      ],
      forbid_args: { list_bookings: ['limit'] },
    }
    expect(grade(c, [turn([{ tool: 'list_bookings', args: {} }], 'КОТТЕДЖ')])).toEqual([])
    expect(
      grade(c, [
        turn(
          [
            { tool: 'list_bookings', args: { limit: 5 } },
            { tool: 'delete_booking', args: {} },
          ],
          'x',
        ),
      ]),
    ).toHaveLength(4)
  })
})
