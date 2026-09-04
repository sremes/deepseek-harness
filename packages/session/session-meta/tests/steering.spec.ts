import { describe, expect, it } from 'vitest'
import { parseSteeringFile, processedSteeringDir, steeringFilePath } from '../src/steering.ts'

describe('parseSteeringFile', () => {
  it('accepts a minimal record', () => {
    expect(parseSteeringFile('s1', { original_task: 'do x', correction: 'do y instead' })).toEqual({
      sessionId: 's1',
      originalTask: 'do x',
      correction: 'do y instead',
    })
  })

  it('accepts optional hints', () => {
    const record = parseSteeringFile('s1', {
      original_task: 'do x',
      correction: 'do y instead',
      intent_hint: 'confirm first',
      verified_by: 'human',
    })
    expect(record.intentHint).toBe('confirm first')
    expect(record.verifiedBy).toBe('human')
  })

  it.each([
    ['null', null],
    ['array', []],
    ['string', 'nope'],
    ['missing original_task', { correction: 'y' }],
    ['empty original_task', { original_task: '  ', correction: 'y' }],
    ['non-string original_task', { original_task: 7, correction: 'y' }],
    ['missing correction', { original_task: 'x' }],
    ['empty correction', { original_task: 'x', correction: '' }],
    ['non-string correction', { original_task: 'x', correction: 7 }],
    ['non-string intent_hint', { original_task: 'x', correction: 'y', intent_hint: 7 }],
    ['non-string verified_by', { original_task: 'x', correction: 'y', verified_by: 7 }],
  ])('rejects %s', (_label, raw) => {
    expect(() => parseSteeringFile('s1', raw)).toThrow(/session-meta: steering record for s1/)
  })
})

describe('steering paths', () => {
  it('nests records under home/meta/steering', () => {
    expect(steeringFilePath('/home', 'abc')).toBe('/home/meta/steering/abc.json')
  })

  it('resolves the processed directory beside pending records', () => {
    expect(processedSteeringDir('/home')).toBe('/home/meta/steering/processed')
  })
})
