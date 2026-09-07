import { describe, expect, it } from 'vitest'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import type { EvaluatorLlm } from '../src/evaluator.ts'
import { buildJudgePrompt, judgePair, parseJudgeJson } from '../src/judge.ts'
import { textChunks, toolCallChunks } from './helpers.ts'

const ROUTE = { provider: 'flash', model: 'flash-1', maxInputBytes: 12000, maxOutputTokens: 2000, timeoutMs: 5000 }

const GROUNDS = 'Approach A retried `edit` at step 2 and the result shows ok'

function verdictJson(verdict: string, grounds = GROUNDS): string {
  return JSON.stringify({ verdict, grounds })
}

/** Fake llm serving one chunk script per stream call, in call order. */
function fakeLlm(runs: readonly (readonly StreamChunk[])[]): EvaluatorLlm {
  let calls = 0
  return {
    async *stream(): AsyncIterable<StreamChunk> {
      const chunks = runs[calls] ?? []
      calls += 1
      yield* chunks
    },
  }
}

describe('buildJudgePrompt', () => {
  it('presents both traces as blinded Approach A/B with no skill identity', () => {
    const prompt = buildJudgePrompt('first trace', 'second trace')
    expect(prompt).toContain('Approach A')
    expect(prompt).toContain('first trace')
    expect(prompt).toContain('Approach B')
    expect(prompt).toContain('second trace')
    expect(prompt.toLowerCase()).not.toContain('candidate')
    expect(prompt.toLowerCase()).not.toContain('baseline')
  })

  it('applies the rubric in fixed order and demands cited grounds plus a JSON-only reply', () => {
    const prompt = buildJudgePrompt('a', 'b')
    const correctness = prompt.indexOf('correctness')
    const robustness = prompt.indexOf('robustness')
    const efficiency = prompt.indexOf('efficiency')
    expect(correctness).toBeGreaterThanOrEqual(0)
    expect(correctness).toBeLessThan(robustness)
    expect(robustness).toBeLessThan(efficiency)
    expect(prompt).toContain('cite the tool call')
    expect(prompt).toContain('exactly one JSON object')
    expect(prompt).toContain('no fences, no prose')
  })
})

describe('parseJudgeJson', () => {
  it('accepts prefer-a, prefer-b, and tie with grounds', () => {
    expect(parseJudgeJson(verdictJson('prefer-a'))).toEqual({ verdict: 'prefer-a', grounds: GROUNDS })
    expect(parseJudgeJson(verdictJson('prefer-b'))?.verdict).toBe('prefer-b')
    expect(parseJudgeJson(verdictJson('tie'))?.verdict).toBe('tie')
  })

  it.each([
    ['not json at all'],
    ['[1, 2]'],
    ['{broken'],
    ['{not valid json}'],
    ['null'],
    ['[]'],
    ['{}'],
    [verdictJson('prefer-c')],
    [verdictJson('PREFER-A')],
    [verdictJson('')],
    [JSON.stringify({ verdict: 'prefer-a' })],
    [JSON.stringify({ verdict: 'prefer-a', grounds: '' })],
    [JSON.stringify({ verdict: 'prefer-a', grounds: '   ' })],
    [JSON.stringify({ verdict: 'prefer-a', grounds: 7 })],
    [JSON.stringify({ verdict: 'tie', grounds: '' })],
    [`\`\`\`json\n${verdictJson('prefer-a')}\n\`\`\``],
  ])('rejects %s', (text) => {
    expect(parseJudgeJson(text)).toBeUndefined()
  })
})

describe('judgePair', () => {
  it('passes when both runs prefer the candidate', async () => {
    const llm = fakeLlm([
      textChunks(verdictJson('prefer-a', 'first run grounds')),
      textChunks(verdictJson('prefer-b', 'second run grounds')),
    ])
    const result = await judgePair(llm, ROUTE, 'candidate trace', 'baseline trace')
    expect(result).toEqual({ pass: true, grounds: ['first run grounds', 'second run grounds'] })
  })

  it('passes on agreed ties with grounds and on candidate-plus-tie', async () => {
    const ties = fakeLlm([textChunks(verdictJson('tie', 'tie one')), textChunks(verdictJson('tie', 'tie two'))])
    expect(await judgePair(ties, ROUTE, 'c', 'b')).toEqual({ pass: true, grounds: ['tie one', 'tie two'] })
    const mixed = fakeLlm([textChunks(verdictJson('prefer-a', 'win')), textChunks(verdictJson('tie', 'draw'))])
    expect(await judgePair(mixed, ROUTE, 'c', 'b')).toEqual({ pass: true, grounds: ['win', 'draw'] })
  })

  it('fails when either run prefers the baseline (harm veto)', async () => {
    const firstFails = fakeLlm([textChunks(verdictJson('prefer-b', 'baseline wins')), textChunks(verdictJson('tie', 'draw'))])
    const first = await judgePair(firstFails, ROUTE, 'c', 'b')
    expect(first.pass).toBe(false)
    expect(first.grounds).toEqual(['baseline wins', 'draw'])
    const secondFails = fakeLlm([textChunks(verdictJson('tie', 'draw')), textChunks(verdictJson('prefer-a', 'baseline wins'))])
    expect((await judgePair(secondFails, ROUTE, 'c', 'b')).pass).toBe(false)
  })

  it('fails on split runs that disagree', async () => {
    const llm = fakeLlm([textChunks(verdictJson('prefer-a', 'win')), textChunks(verdictJson('prefer-a', 'loss'))])
    const result = await judgePair(llm, ROUTE, 'c', 'b')
    expect(result.pass).toBe(false)
    expect(result.grounds).toEqual(['win', 'loss'])
  })

  it('fails closed on invalid JSON, keeping whatever grounds were obtained', async () => {
    const llm = fakeLlm([[{ type: 'text-delta', index: 0, text: 'not json' } as StreamChunk], textChunks(verdictJson('prefer-b', 'kept'))])
    const result = await judgePair(llm, ROUTE, 'c', 'b')
    expect(result.pass).toBe(false)
    expect(result.grounds).toEqual(['kept'])
  })

  it('fails an empty-grounds tie', async () => {
    const llm = fakeLlm([
      textChunks(verdictJson('tie', 'grounded')),
      textChunks(JSON.stringify({ verdict: 'tie', grounds: '' })),
    ])
    const result = await judgePair(llm, ROUTE, 'c', 'b')
    expect(result.pass).toBe(false)
    expect(result.grounds).toEqual(['grounded'])
  })

  it('fails closed on oversized input without calling the model', async () => {
    let called = false
    const llm: EvaluatorLlm = {
      async *stream(): AsyncIterable<StreamChunk> {
        called = true
        yield* []
      },
    }
    const result = await judgePair(llm, { ...ROUTE, maxInputBytes: 8 }, 'c', 'b')
    expect(result).toEqual({ pass: false, grounds: [] })
    expect(called).toBe(false)
  })

  it('fails closed on truncated, tool-call, empty, and throwing runs', async () => {
    const length: StreamChunk[] = [
      ...textChunks(verdictJson('prefer-a')).slice(0, 3),
      { type: 'finish', reason: { kind: 'length' } as unknown as { kind: 'stop' } },
    ]
    expect((await judgePair(fakeLlm([length, length]), ROUTE, 'c', 'b')).pass).toBe(false)
    const failed: StreamChunk[] = [
      ...textChunks(verdictJson('prefer-a')).slice(0, 3),
      { type: 'finish', reason: { kind: 'error', failure: { message: 'boom', code: 'E_UPSTREAM' } } },
    ]
    expect((await judgePair(fakeLlm([failed, failed]), ROUTE, 'c', 'b')).pass).toBe(false)
    const tools = fakeLlm([toolCallChunks(), toolCallChunks()])
    expect((await judgePair(tools, ROUTE, 'c', 'b')).pass).toBe(false)
    const silent: StreamChunk[] = [{ type: 'finish', reason: { kind: 'stop' } }]
    expect((await judgePair(fakeLlm([silent, silent]), ROUTE, 'c', 'b')).pass).toBe(false)
    const throwing: EvaluatorLlm = {
      async *stream(): AsyncIterable<StreamChunk> {
        throw new Error('boom')
        yield* []
      },
    }
    expect((await judgePair(throwing, ROUTE, 'c', 'b')).pass).toBe(false)
  })
})
