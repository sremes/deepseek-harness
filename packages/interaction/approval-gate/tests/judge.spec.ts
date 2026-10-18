/**
 * Judge specs: the bounded verdict call parses schema-clean decisions and
 * degrades every infrastructure fault to `undefined` — all through an
 * injected fetch, never the network.
 */

import { describe, expect, it } from 'vitest'
import { judgeCommand } from '../src/judge.ts'
import type { JudgeFetch, JudgeInput } from '../src/types.ts'

const INPUT: JudgeInput = {
  command: 'vitest run x',
  cwd: '/w',
  requestedMode: 'danger-full-access',
  justification: 'escalate sandbox to danger-full-access: no backend here',
}

const OPTIONS = {
  url: 'https://judge.test/v1/openai',
  model: 'test-flash',
  apiKey: 'test-key',
  api: 'openai-completions',
  timeoutMs: 1000,
} as const

const RESPOND_OPTIONS = {
  url: 'https://judge.test/zen/go/v1',
  model: 'test-spark',
  apiKey: 'test-key',
  api: 'openai-responses',
  headers: { 'x-opencode-session': 'test-session' },
  timeoutMs: 1000,
} as const

/** Fetch stub serving one canned response (or throwing). */
function stubFetch(handler: () => unknown): JudgeFetch {
  return (async () => handler()) as JudgeFetch
}

/** Canned judge verdict body. */
function verdictBody(verdict: unknown, grounds: unknown): unknown {
  return { choices: [{ message: { content: JSON.stringify({ verdict, grounds }) } }] }
}

describe('judgeCommand', () => {
  it('parses an allow verdict with grounds', async () => {
    let seenUrl = ''
    let seenInit: { headers?: Record<string, string>; body?: string } = {}
    const verdict = await judgeCommand(INPUT, {
      ...OPTIONS,
      fetchFn: (async (url: string, init: { headers: Record<string, string>; body: string }) => {
        seenUrl = url
        seenInit = init
        return { ok: true, status: 200, json: async () => verdictBody('allow', 'read-only build step') }
      }) as JudgeFetch,
    })
    expect(verdict).toEqual({ verdict: 'allow', grounds: 'read-only build step' })
    expect(seenUrl).toBe('https://judge.test/v1/openai/chat/completions')
    expect(seenInit.headers?.['Authorization']).toBe('Bearer test-key')
    const body = JSON.parse(seenInit.body ?? '{}') as { model?: unknown; temperature?: unknown }
    expect(body).toMatchObject({ model: 'test-flash', temperature: 0 })
  })

  it('parses a reject verdict', async () => {
    const verdict = await judgeCommand(INPUT, {
      ...OPTIONS,
      fetchFn: stubFetch(() => ({ ok: true, status: 200, json: async () => verdictBody('reject', 'deletes state') })),
    })
    expect(verdict).toEqual({ verdict: 'reject', grounds: 'deletes state' })
  })

  it('degrades non-OK statuses without reading the body', async () => {
    let read = false
    const verdict = await judgeCommand(INPUT, {
      ...OPTIONS,
      fetchFn: stubFetch(() => ({
        ok: false,
        status: 429,
        json: async () => {
          read = true
          return {}
        },
      })),
    })
    expect(verdict).toBeUndefined()
    expect(read).toBe(false)
  })

  it('degrades transport throws, bad JSON, and wrong shapes', async () => {
    const throwing: JudgeFetch = (async () => {
      throw new Error('socket died')
    }) as JudgeFetch
    await expect(judgeCommand(INPUT, { ...OPTIONS, fetchFn: throwing })).resolves.toBeUndefined()
    const badJson: JudgeFetch = (async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError('not json')
      },
    })) as JudgeFetch
    await expect(judgeCommand(INPUT, { ...OPTIONS, fetchFn: badJson })).resolves.toBeUndefined()
    for (const body of [
      { choices: [{ message: { content: '{"verdict":"maybe","grounds":"x"}' } }] },
      { choices: [{ message: { content: '{"verdict":"allow","grounds":""}' } }] },
      { choices: [{ message: { content: '{"verdict":"allow"}' } }] },
      { choices: [{ message: { content: 'not json at all' } }] },
      { choices: [{ message: {} }] },
      { choices: [{}] },
      { choices: [] },
      { choices: ['x'] },
      { choices: [{ message: { content: '"justastring"' } }] },
      {},
      'just a string',
    ]) {
      const shaped: JudgeFetch = (async () => ({ ok: true, status: 200, json: async () => body })) as JudgeFetch
      await expect(judgeCommand(INPUT, { ...OPTIONS, fetchFn: shaped })).resolves.toBeUndefined()
    }
  })

  it('degrades past the timeout', async () => {
    const hanging: JudgeFetch = (() => new Promise(() => {})) as JudgeFetch
    await expect(
      judgeCommand(INPUT, { ...OPTIONS, timeoutMs: 20, fetchFn: hanging }),
    ).resolves.toBeUndefined()
  })
})

/** Canned Responses-API verdict body (reasoning item plus message item). */
function respondBody(verdict: unknown, grounds: unknown): unknown {
  return {
    status: 'completed',
    output: [
      { type: 'reasoning', status: 'completed' },
      {
        type: 'message',
        content: [{ type: 'output_text', text: JSON.stringify({ verdict, grounds }) }],
      },
    ],
  }
}

describe('judgeCommand over openai-responses', () => {
  it('posts to /responses and parses message output-text', async () => {
    let seenUrl = ''
    let seenInit: { headers?: Record<string, string>; body?: string } = {}
    const verdict = await judgeCommand(INPUT, {
      ...RESPOND_OPTIONS,
      fetchFn: (async (url: string, init: { headers: Record<string, string>; body: string }) => {
        seenUrl = url
        seenInit = init
        return { ok: true, status: 200, json: async () => respondBody('allow', 'benign echo') }
      }) as JudgeFetch,
    })
    expect(verdict).toEqual({ verdict: 'allow', grounds: 'benign echo' })
    expect(seenUrl).toBe('https://judge.test/zen/go/v1/responses')
    expect(seenInit.headers?.['Authorization']).toBe('Bearer test-key')
    expect(seenInit.headers?.['x-opencode-session']).toBe('test-session')
    const body = JSON.parse(seenInit.body ?? '{}') as { model?: unknown; instructions?: unknown; input?: unknown; reasoning?: unknown }
    expect(body).toMatchObject({ model: 'test-spark', reasoning: { effort: 'low' } })
    expect(typeof body.instructions).toBe('string')
    expect(typeof body.input).toBe('string')
  })

  it('degrades reasoning-only, missing, and malformed outputs', async () => {
    for (const envelope of [
      { status: 'incomplete', output: [{ type: 'reasoning', status: 'incomplete' }] },
      { status: 'completed', output: [] },
      { status: 'completed', output: [{ type: 'message', content: [] }] },
      {
        status: 'completed',
        output: [{ type: 'message', content: [{ type: 'output_text', text: 'not json' }] }],
      },
      {
        status: 'completed',
        output: [{ type: 'message', content: [{ type: 'output_text', text: '{"verdict":"maybe","grounds":"x"}' }] }],
      },
      { status: 'completed' },
      'just a string',
    ]) {
      const shaped: JudgeFetch = (async () => ({
        ok: true,
        status: 200,
        json: async () => envelope,
      })) as JudgeFetch
      await expect(judgeCommand(INPUT, { ...RESPOND_OPTIONS, fetchFn: shaped })).resolves.toBeUndefined()
    }
  })
})
