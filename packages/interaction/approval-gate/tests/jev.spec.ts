/**
 * Jev backend specs: typed Choice parsing, calibration passthrough, and
 * fault degradation — all through an injected fetch, never the network.
 */

import { describe, expect, it } from 'vitest'
import { jevVerdict } from '../src/jev.ts'
import type { JudgeFetch, JudgeInput } from '../src/types.ts'

const INPUT: JudgeInput = {
  command: 'npm test',
  cwd: '/w',
  requestedMode: 'danger-full-access',
  justification: 'need tests',
}

const OPTIONS = {
  url: 'https://jev.test/v1/systemone',
  model: 'jev-preview',
  apiKey: 'test-key',
  timeoutMs: 1000,
} as const

/** Canned System One verdict body. */
function jevBody(choice: unknown, top: number, confidence = 0.9, model = 'jev-1.14.0'): unknown {
  return {
    model,
    answers: {
      verdict: {
        type: 'choice',
        choice,
        probabilities: { allow: choice === 'allow' ? top : 1 - top, reject: choice === 'reject' ? top : 1 - top },
        confidence,
      },
    },
    usage: { input_tokens: 100, output_tokens: 20 },
  }
}

function stubFetch(body: unknown, status = 200): JudgeFetch {
  return (async () => ({ ok: status >= 200 && status < 300, status, json: async () => body })) as JudgeFetch
}

describe('jevVerdict', () => {
  it('parses an allow verdict with calibration and the versioned model id', async () => {
    let seenUrl = ''
    let seenInit: { headers?: Record<string, string>; body?: string } = {}
    const verdict = await jevVerdict(INPUT, {
      ...OPTIONS,
      fetchFn: (async (url: string, init: { headers: Record<string, string>; body: string }) => {
        seenUrl = url
        seenInit = init
        return { ok: true, status: 200, json: async () => jevBody('allow', 0.92) }
      }) as JudgeFetch,
    })
    expect(verdict).toMatchObject({ choice: 'allow', top: 0.92, confidence: 0.9, model: 'jev-1.14.0' })
    expect(typeof verdict?.latencyMs).toBe('number')
    expect(seenUrl).toBe('https://jev.test/v1/systemone')
    expect(seenInit.headers?.['Authorization']).toBe('Bearer test-key')
    const body = JSON.parse(seenInit.body ?? '{}') as { model?: unknown; questions?: unknown }
    expect(body.model).toBe('jev-preview')
    expect(body.questions).toHaveProperty('verdict')
  })

  it('falls back to the configured model id when the response names none', async () => {
    const verdict = await jevVerdict(INPUT, { ...OPTIONS, fetchFn: stubFetch({ answers: { verdict: { type: 'choice', choice: 'reject', probabilities: { allow: 0.1, reject: 0.9 }, confidence: 0.85 } } }) })
    expect(verdict).toMatchObject({ choice: 'reject', model: 'jev-preview' })
  })

  it('degrades non-OK, throws, bad JSON, and malformed answers', async () => {
    const throwing: JudgeFetch = (async () => {
      throw new Error('socket died')
    }) as JudgeFetch
    await expect(jevVerdict(INPUT, { ...OPTIONS, fetchFn: throwing })).resolves.toBeUndefined()
    const badJson: JudgeFetch = (async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError('not json')
      },
    })) as JudgeFetch
    await expect(jevVerdict(INPUT, { ...OPTIONS, fetchFn: badJson })).resolves.toBeUndefined()
    for (const envelope of [
      { model: 'jev-1.14.0', answers: { verdict: { type: 'choice', choice: 'maybe', probabilities: { allow: 0.5, reject: 0.5 }, confidence: 0.5 } } },
      { model: 'jev-1.14.0', answers: { verdict: { type: 'choice', choice: 'allow', probabilities: { allow: 'high', reject: 0.1 }, confidence: 0.9 } } },
      { model: 'jev-1.14.0', answers: { verdict: { type: 'choice', choice: 'allow', probabilities: { allow: 0.9, reject: 0.1 } } } },
      { model: 'jev-1.14.0', answers: { verdict: { type: 'choice', choice: 'allow', probabilities: null, confidence: 0.9 } } },
      { model: 'jev-1.14.0', answers: {} },
      { model: 'jev-1.14.0' },
      {},
      'just a string',
    ]) {
      await expect(jevVerdict(INPUT, { ...OPTIONS, fetchFn: stubFetch(envelope) })).resolves.toBeUndefined()
    }
    await expect(jevVerdict(INPUT, { ...OPTIONS, fetchFn: stubFetch({}, 429) })).resolves.toBeUndefined()
  })

  it('degrades past the timeout', async () => {
    const hanging: JudgeFetch = (() => new Promise(() => {})) as JudgeFetch
    await expect(
      jevVerdict(INPUT, { ...OPTIONS, timeoutMs: 20, fetchFn: hanging }),
    ).resolves.toBeUndefined()
  })
})
