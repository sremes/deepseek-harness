import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { MetaStore } from '../src/store.ts'
import {
  MAX_RESULT_DIGEST_CHARS,
  MAX_SKILLS_CONSULTED,
  MAX_STEERING_TEXTS,
  MAX_TOOL_ARG_CHARS,
  MAX_TOOL_STEPS,
  hasExplicitPersistRequest,
  messageText,
  observeToolCall,
  observeToolResult,
  observeUserMessage,
  resultCallId,
  resultText,
} from '../src/triage.ts'
import { optionalLlm, resolveEvaluation, settleSessionMeta } from '../src/index.ts'
import { shouldEvaluateTrackA } from '../src/orchestrate.ts'
import type { SessionAggregate } from '../src/types.ts'
import { makeAggregate } from './helpers.ts'

function human(text: string): unknown {
  return { source: { kind: 'user' }, content: [{ type: 'text', text }] }
}

describe('messageText', () => {
  it('joins text blocks and skips other block types', () => {
    expect(messageText({ content: [{ type: 'text', text: 'a' }, { type: 'image' }, { type: 'text', text: 'b' }] })).toBe('a\nb')
  })

  it('falls back to a capped JSON dump', () => {
    expect(messageText({ content: [{ type: 'text', text: '' }] })).toBe(JSON.stringify({ content: [{ type: 'text', text: '' }] }))
    expect(messageText(42)).toBe('42')
    expect(messageText(null)).toBe('null')
    expect(messageText(undefined)).toBe('')
  })

  it('returns empty on circular payloads', () => {
    const circular: Record<string, unknown> = {}
    circular.self = circular
    expect(messageText(circular)).toBe('')
  })
})

describe('observeToolCall', () => {
  it('slots unknown tools without a call-id mapping', () => {
    const aggregate = makeAggregate('s1')
    observeToolCall(aggregate, undefined)
    observeToolCall(aggregate, { name: '' })
    expect(aggregate.toolSteps).toEqual([{ tool: 'unknown-tool', ok: true }, { tool: 'unknown-tool', ok: true }])
    expect(aggregate.pendingToolCalls.size).toBe(0)
  })

  it('maps call ids and drops steps past the bound', () => {
    const aggregate = makeAggregate('s1')
    observeToolCall(aggregate, { name: 'read', callId: 'c1' })
    expect(aggregate.pendingToolCalls.get('c1')).toBe(0)
    observeToolCall(aggregate, { name: 'read' })
    expect(aggregate.pendingToolCalls.size).toBe(1)
    for (let n = aggregate.toolSteps.length; n < MAX_TOOL_STEPS; n += 1) {
      observeToolCall(aggregate, { name: 'read' })
    }
    observeToolCall(aggregate, { name: 'read', callId: 'overflow' })
    expect(aggregate.toolSteps).toHaveLength(MAX_TOOL_STEPS)
    expect(aggregate.truncatedToolSteps).toBe(1)
    expect(aggregate.pendingToolCalls.has('overflow')).toBe(false)
  })
})

describe('observeToolResult', () => {
  it('folds errors without attribution when no call id is known', () => {
    const aggregate = makeAggregate('s1')
    observeToolResult(aggregate, undefined)
    observeToolResult(aggregate, { callId: 'ghost', error: { name: 'EditFailed' } })
    expect(aggregate.toolErrors).toEqual(['unknown-error', 'EditFailed'])
    expect(aggregate.toolSteps).toEqual([])
  })

  it('marks the matching step failed via top-level and nested call ids', () => {
    const aggregate = makeAggregate('s1')
    observeToolCall(aggregate, { name: 'edit', callId: 'c1' })
    observeToolCall(aggregate, { name: 'read', callId: 'c2' })
    observeToolResult(aggregate, { callId: 'c1', error: { name: 'EditFailed' } })
    observeToolResult(aggregate, { message: { callId: 'c2' }, error: 'timeout' })
    expect(aggregate.toolSteps[0]).toEqual({ tool: 'edit', ok: false, error: 'EditFailed' })
    expect(aggregate.toolSteps[1]).toEqual({ tool: 'read', ok: false, error: 'timeout' })
  })

  it('ignores dangling call-id mappings', () => {
    const aggregate = makeAggregate('s1')
    aggregate.pendingToolCalls.set('ghost', 99)
    observeToolResult(aggregate, { callId: 'ghost', error: 'x' })
    expect(aggregate.toolErrors).toEqual(['x'])
  })

  it('ignores non-string nested call ids', () => {
    const aggregate = makeAggregate('s1')
    observeToolResult(aggregate, { message: { callId: 7 }, error: 'x' })
    expect(aggregate.toolSteps).toEqual([])
  })
})

describe('observeUserMessage', () => {
  it('captures the opening task once and counts steering separately', () => {
    const aggregate = makeAggregate('s1')
    observeUserMessage(aggregate, human('do the thing'), false)
    observeUserMessage(aggregate, human('second thought'), false)
    expect(aggregate.openingTask).toBe('do the thing')
    expect(aggregate.steeringEvents).toBe(0)
    observeUserMessage(aggregate, human('not like that'), true)
    expect(aggregate.openingTask).toBe('do the thing')
    expect(aggregate.steeringEvents).toBe(1)
    expect(aggregate.steeringTexts).toEqual(['not like that'])
  })

  it('ignores non-human and sourceless payloads', () => {
    const aggregate = makeAggregate('s1')
    observeUserMessage(aggregate, undefined, true)
    observeUserMessage(aggregate, { content: [] }, true)
    observeUserMessage(aggregate, { source: 5 }, true)
    observeUserMessage(aggregate, { source: { kind: 'plugin' }, content: [{ type: 'text', text: 'x' }] }, true)
    expect(aggregate.openingTask).toBeUndefined()
    expect(aggregate.steeringEvents).toBe(0)
  })

  it('bounds retained steering texts', () => {
    const aggregate = makeAggregate('s1')
    for (let n = 0; n < MAX_STEERING_TEXTS + 1; n += 1) {
      observeUserMessage(aggregate, human(`correction-${n}`), true)
    }
    expect(aggregate.steeringTexts).toHaveLength(MAX_STEERING_TEXTS)
    expect(aggregate.steeringTexts[0]).toBe('correction-1')
  })
})

describe('evaluator ledger', () => {
  it('counts recorded evaluations inside a day window', () => {
    const store = new MetaStore({ dbPath: ':memory:' })
    try {
      expect(store.countEvaluationsSince(0)).toBe(0)
      store.recordEvaluation({ ts: 100, sessionId: 'a', inputTokens: 1, outputTokens: 2, decision: 'draft-written', draftSlug: 's' })
      store.recordEvaluation({ ts: 200, sessionId: 'b', inputTokens: 0, outputTokens: 0, decision: 'budget-refused', draftSlug: null })
      expect(store.countEvaluationsSince(0)).toBe(2)
      expect(store.countEvaluationsSince(150)).toBe(1)
      expect(store.countEvaluationsSince(300)).toBe(0)
    } finally {
      store.close()
    }
  })

  it('migrates a v1 database forward', async () => {
    let dir: string | undefined
    try {
      dir = await mkdtemp(join(tmpdir(), 'dsh-meta-v1-'))
      const path = join(dir, 'meta.db')
      const legacy = new DatabaseSync(path)
      legacy.exec('CREATE TABLE meta_sessions(id TEXT PRIMARY KEY); PRAGMA user_version = 1;')
      legacy.close()
      const store = new MetaStore({ dbPath: path })
      try {
        store.recordEvaluation({ ts: 1, sessionId: 'a', inputTokens: 0, outputTokens: 0, decision: 'x', draftSlug: null })
        expect(store.countEvaluationsSince(0)).toBe(1)
      } finally {
        store.close()
      }
    } finally {
      if (dir !== undefined) await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('resolveEvaluation', () => {
  it('stays disabled with defaults and a home-derived skills dir', () => {
    expect(resolveEvaluation({ dshHome: '/home' }, '/home')).toEqual({
      enabled: false,
      provider: '',
      model: '',
      maxInputBytes: 12000,
      maxOutputTokens: 2000,
      timeoutMs: 120000,
      maxCallsPerDay: 1,
      maxReplaysPerDay: 8,
      minEvalToolCalls: 3,
      earlySteeringMessages: 1,
      maxPromotionsPerWeek: 3,
      skillsDir: '/home/skills',
    })
  })

  it('requires an explicit route when enabled', () => {
    expect(() => resolveEvaluation({ evaluator: { enabled: true } }, '/home')).toThrow(/requires explicit/)
    expect(() => resolveEvaluation({ evaluator: { enabled: true, provider: 'p' } }, '/home')).toThrow(/requires explicit/)
  })

  it('keeps explicit limits and skill roots', () => {
    expect(
      resolveEvaluation(
        { skillsDir: '/skills', evaluator: { enabled: true, provider: 'p', model: 'm', maxCallsPerDay: 0, timeoutMs: 5 } },
        '/home',
      ),
    ).toMatchObject({ enabled: true, provider: 'p', model: 'm', maxCallsPerDay: 0, timeoutMs: 5, skillsDir: '/skills' })
  })
})

describe('shouldEvaluateTrackA', () => {
  const EFFORT = { minEvalToolCalls: 3, earlySteeringMessages: 1 }

  function gated(sessionId: string, build: (aggregate: SessionAggregate) => void): boolean {
    const aggregate = makeAggregate(sessionId)
    build(aggregate)
    return shouldEvaluateTrackA('track_a', true, aggregate, aggregate.steeringTexts.length > 0, EFFORT)
  }

  it('rejects wrong routes, disabled loops, and missing steering', () => {
    const aggregate = makeAggregate('s1')
    aggregate.toolCalls = 9
    expect(shouldEvaluateTrackA('track_b', true, aggregate, true, EFFORT)).toBe(false)
    expect(shouldEvaluateTrackA('no_op', true, aggregate, true, EFFORT)).toBe(false)
    expect(shouldEvaluateTrackA('track_a', false, aggregate, true, EFFORT)).toBe(false)
    expect(shouldEvaluateTrackA('track_a', true, aggregate, false, EFFORT)).toBe(false)
  })

  it('evaluates substantial steered sessions', () => {
    expect(gated('s1', (aggregate) => {
      aggregate.toolCalls = 5
      aggregate.assistantMessages = 4
      aggregate.assistantMessagesAtFirstSteering = 4
      aggregate.steeringTexts.push('use the other endpoint')
    })).toBe(true)
  })

  it('skips typo-class sessions: few calls, early steering, no recovery', () => {
    expect(gated('s1', (aggregate) => {
      aggregate.toolCalls = 1
      aggregate.assistantMessages = 1
      aggregate.assistantMessagesAtFirstSteering = 1
      aggregate.steeringTexts.push('typo: teh -> the')
    })).toBe(false)
  })

  it('evaluates recovered sessions even without steering', () => {
    expect(gated('s1', (aggregate) => {
      aggregate.toolCalls = 2
      aggregate.toolSteps.push({ tool: 'edit', ok: false, error: 'E' }, { tool: 'edit', ok: true })
    })).toBe(true)
  })

  it('lets explicit persist requests bypass the effort gate', () => {
    expect(gated('s1', (aggregate) => {
      aggregate.toolCalls = 1
      aggregate.assistantMessages = 1
      aggregate.assistantMessagesAtFirstSteering = 1
      aggregate.steeringTexts.push('remember this for next time')
    })).toBe(true)
  })
})

describe('optionalLlm', () => {
  it('passes through a usable service and rejects the rest', () => {
    const usable = { stream: async function* () {} }
    expect(optionalLlm({ get: () => usable } as unknown as Context)).toBe(usable)
    expect(optionalLlm({ get: () => null } as unknown as Context)).toBeUndefined()
    expect(optionalLlm({ get: () => undefined } as unknown as Context)).toBeUndefined()
    expect(optionalLlm({ get: () => ({ stream: 7 }) } as unknown as Context)).toBeUndefined()
  })
})

describe('settleSessionMeta', () => {
  it('resolves without queued work', async () => {
    await expect(settleSessionMeta()).resolves.toBeUndefined()
  })
})

describe('M2.1 grounding capture', () => {
  it('retains redacted truncated tool arguments', () => {
    const aggregate = makeAggregate('s1')
    observeToolCall(aggregate, { name: 'edit', callId: 'c1', arguments: JSON.stringify({ path: '/tmp/f', token: 'sk-abcdefgh1234' }) })
    expect(aggregate.toolSteps[0]?.args).toBe(JSON.stringify({ path: '/tmp/f', token: '[REDACTED:sk]' }))
    observeToolCall(aggregate, { name: 'read', arguments: 'x'.repeat(MAX_TOOL_ARG_CHARS + 50) })
    expect(aggregate.toolSteps[1]?.args).toHaveLength(MAX_TOOL_ARG_CHARS)
    observeToolCall(aggregate, { name: 'noop', arguments: 7 })
    expect(aggregate.toolSteps[2]).toEqual({ tool: 'noop', ok: true })
  })

  it('folds skill-tool consults best-effort', () => {
    const aggregate = makeAggregate('s1')
    observeToolCall(aggregate, { name: 'skill', arguments: JSON.stringify({ name: 'triage' }) })
    observeToolCall(aggregate, { name: 'skill', arguments: JSON.stringify({ name: 'triage' }) })
    observeToolCall(aggregate, { name: 'skill', arguments: 'not json' })
    observeToolCall(aggregate, { name: 'skill', arguments: JSON.stringify({ name: 7 }) })
    observeToolCall(aggregate, { name: 'read', arguments: JSON.stringify({ name: 'triage' }) })
    expect(aggregate.skillsConsulted).toEqual(['triage'])
    for (let n = 0; n < MAX_SKILLS_CONSULTED; n += 1) {
      observeToolCall(aggregate, { name: 'skill', arguments: JSON.stringify({ name: `s${n}` }) })
    }
    expect(aggregate.skillsConsulted).toHaveLength(MAX_SKILLS_CONSULTED)
  })

  it('retains a result digest on the failed step only', () => {
    const aggregate = makeAggregate('s1')
    observeToolCall(aggregate, { name: 'edit', callId: 'c1' })
    observeToolResult(aggregate, {
      callId: 'c1',
      error: { name: 'EditFailed' },
      message: { content: [{ type: 'text', text: 'path not found' }, { type: 'image' }] },
    })
    expect(aggregate.toolSteps[0]).toMatchObject({ ok: false, error: 'EditFailed', resultDigest: 'path not found' })
    observeToolCall(aggregate, { name: 'read', callId: 'c2' })
    observeToolResult(aggregate, { callId: 'c2', error: 'x' })
    expect(aggregate.toolSteps[1]?.resultDigest).toBeUndefined()
  })

  it('marks the assistant-message count at first steering only', () => {
    const aggregate = makeAggregate('s1')
    aggregate.assistantMessages = 3
    observeUserMessage(aggregate, human('first correction'), true)
    aggregate.assistantMessages = 5
    observeUserMessage(aggregate, human('second correction'), true)
    expect(aggregate.assistantMessagesAtFirstSteering).toBe(3)
  })
})

describe('resultText', () => {
  it('joins message text blocks and caps length', () => {
    expect(resultText({ message: { content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] } })).toBe('a\nb')
    expect(resultText({ message: { content: [{ type: 'text', text: 'x'.repeat(MAX_RESULT_DIGEST_CHARS + 10) }] } })).toHaveLength(
      MAX_RESULT_DIGEST_CHARS,
    )
  })

  it('returns empty on missing or odd shapes', () => {
    expect(resultText(undefined)).toBe('')
    expect(resultText({})).toBe('')
    expect(resultText({ message: 7 })).toBe('')
    expect(resultText({ message: { content: [{ type: 'image' }] } })).toBe('')
  })
})

describe('resultCallId', () => {
  it('prefers top-level ids, then message nests, then content blocks', () => {
    expect(resultCallId('top', { callId: 'nested' })).toBe('top')
    expect(resultCallId(undefined, { callId: 'direct' })).toBe('direct')
    expect(resultCallId(undefined, { source: { kind: 'tool', callId: 'sourced' } })).toBe('sourced')
    expect(
      resultCallId(undefined, { content: [{ type: 'tool-result', toolCallId: 'blocked' }] }),
    ).toBe('blocked')
  })

  it('skips empty and non-string ids and survives odd shapes', () => {
    expect(resultCallId('', { callId: 'fallback' })).toBe('fallback')
    expect(resultCallId(undefined, { callId: '', source: { callId: 'sourced' } })).toBe('sourced')
    expect(resultCallId(undefined, undefined)).toBeUndefined()
    expect(resultCallId(undefined, 7)).toBeUndefined()
    expect(resultCallId(undefined, { source: 7, content: [{ toolCallId: 7 }, null] })).toBeUndefined()
    expect(resultCallId(undefined, { content: [{ type: 'text', text: 'x' }] })).toBeUndefined()
  })

  it('attributes live-shaped error results to their call step', () => {
    const aggregate = makeAggregate('s1')
    observeToolCall(aggregate, { name: 'edit', callId: 'f1' })
    observeToolResult(aggregate, {
      error: { name: 'E_TIMEOUT' },
      message: { source: { kind: 'tool', callId: 'f1' }, content: [{ type: 'tool-result', toolCallId: 'f1' }] },
    })
    expect(aggregate.toolSteps[0]).toMatchObject({ tool: 'edit', ok: false, error: 'E_TIMEOUT' })
  })
})

describe('hasExplicitPersistRequest', () => {
  it.each([
    ['remember this for next time', true],
    ['From now on, confirm first', true],
    ['as a rule, never rm -rf /tmp', true],
    ["don't forget the changelog", true],
    ['not like that, do it again', false],
    ['', false],
  ])('classifies %s -> %s', (text, expected) => {
    expect(hasExplicitPersistRequest([text])).toBe(expected)
  })
})
