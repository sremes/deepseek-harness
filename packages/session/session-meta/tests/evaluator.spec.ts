import { describe, expect, it } from 'vitest'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import type { EvaluatorLlm } from '../src/evaluator.ts'
import { buildEvaluatorPrompt, parseProposal, runEvaluator } from '../src/evaluator.ts'
import { makeAggregate, textChunks, toolCallChunks, VALID_PROPOSAL_JSON } from './helpers.ts'
import { projectSession } from '../src/projection.ts'

const ROUTE = { provider: 'flash', model: 'flash-1', maxInputBytes: 12000, maxOutputTokens: 2000, timeoutMs: 5000 }

function fakeLlm(chunks: readonly StreamChunk[], seen?: { provider?: string; model?: string }): EvaluatorLlm {
  return {
    async *stream(options: { provider: string; model: string }): AsyncIterable<StreamChunk> {
      if (seen !== undefined) {
        seen.provider = options.provider
        seen.model = options.model
      }
      yield* chunks
    },
  }
}

function input(intentHint?: string) {
  const aggregate = makeAggregate('s1')
  aggregate.openingTask = 'do x'
  return {
    projection: projectSession(aggregate),
    steering: [{ sessionId: 's1', originalTask: 'do x', correction: 'do y', ...(intentHint === undefined ? {} : { intentHint }) }],
  }
}

describe('buildEvaluatorPrompt', () => {
  it('serializes the projection with steering records', () => {
    const prompt = JSON.parse(buildEvaluatorPrompt(input('confirm first'))) as Record<string, unknown>
    expect(prompt.goal).toBe('do x')
    expect(prompt.steering_records).toEqual([{ original_task: 'do x', correction: 'do y', intent_hint: 'confirm first' }])
  })

  it('omits absent intent hints', () => {
    const prompt = JSON.parse(buildEvaluatorPrompt(input())) as { steering_records: unknown[] }
    expect(prompt.steering_records).toEqual([{ original_task: 'do x', correction: 'do y' }])
  })
})

describe('parseProposal', () => {
  it('accepts a fenced object', () => {
    expect(parseProposal(`\`\`\`json\n${VALID_PROPOSAL_JSON}\n\`\`\``).triggerSignature).toBe('destructive-path-confirm')
  })

  it('accepts a bare object', () => {
    expect(parseProposal(VALID_PROPOSAL_JSON).platform).toBe('dsh-headless')
  })

  it.each([
    ['not json at all', /must be a single JSON object/],
    ['[1, 2]', /must be a single JSON object/],
    ['"just a string"', /must be a single JSON object/],
    ['{broken', /must be a single JSON object/],
    ['null', /must be a single JSON object/],
    ['[]', /must be a single JSON object/],
    ['{}', /non-empty intent/],
    [JSON.stringify({ intent: '  ' }), /non-empty intent/],
    [JSON.stringify({ intent: 'x' }), /forbidden must be a string array/],
    [JSON.stringify({ intent: 'x', forbidden: ['a', 7] }), /forbidden must be a string array/],
    [JSON.stringify({ intent: 'x', forbidden: [] }), /prescribed must be a non-empty string array/],
    [JSON.stringify({ intent: 'x', forbidden: [], prescribed: [] }), /prescribed must be a non-empty string array/],
    [JSON.stringify({ intent: 'x', forbidden: [], prescribed: ['p'] }), /non-empty trigger_signature/],
    [JSON.stringify({ intent: 'x', forbidden: [], prescribed: ['p'], trigger_signature: 't' }), /non-empty platform/],
  ])('rejects %s', (text, pattern) => {
    expect(() => parseProposal(text)).toThrow(pattern)
  })

  it('rejects malformed JSON inside braces', () => {
    expect(() => parseProposal('{not valid json}')).toThrow(/not valid JSON/)
  })
})

describe('runEvaluator', () => {
  it('returns the validated proposal with measured usage on the routed model', async () => {
    const seen: { provider?: string; model?: string } = {}
    const result = await runEvaluator(fakeLlm(textChunks(VALID_PROPOSAL_JSON, { inputTokens: 11, outputTokens: 22 }), seen), ROUTE, input())
    expect(result.proposal.triggerSignature).toBe('destructive-path-confirm')
    expect(result.inputTokens).toBe(11)
    expect(result.outputTokens).toBe(22)
    expect(seen).toEqual({ provider: 'flash', model: 'flash-1' })
  })

  it('reports zero usage when the adapter omits it', async () => {
    const result = await runEvaluator(fakeLlm(textChunks(VALID_PROPOSAL_JSON)), ROUTE, input())
    expect(result.inputTokens).toBe(0)
    expect(result.outputTokens).toBe(0)
  })

  it('refuses oversized input before any model call', async () => {
    let called = false
    const llm: EvaluatorLlm = {
      async *stream(): AsyncIterable<StreamChunk> {
        called = true
        yield* []
      },
    }
    await expect(runEvaluator(llm, { ...ROUTE, maxInputBytes: 8 }, input())).rejects.toThrow(/exceeds maxInputBytes/)
    expect(called).toBe(false)
  })

  it('rejects length-truncated and failed calls', async () => {
    const length: StreamChunk[] = [
      ...textChunks(VALID_PROPOSAL_JSON).slice(0, 3),
      { type: 'finish', reason: { kind: 'length' } as unknown as { kind: 'stop' } },
    ]
    await expect(runEvaluator(fakeLlm(length), ROUTE, input())).rejects.toThrow(/finished with length/)
    const failed: StreamChunk[] = [
      ...textChunks(VALID_PROPOSAL_JSON).slice(0, 3),
      { type: 'finish', reason: { kind: 'error', failure: { message: 'boom', code: 'E_UPSTREAM' } } },
    ]
    await expect(runEvaluator(fakeLlm(failed), ROUTE, input())).rejects.toThrow(/finished with error/)
  })

  it('rejects tool-call output and empty output', async () => {
    await expect(runEvaluator(fakeLlm(toolCallChunks()), ROUTE, input())).rejects.toThrow(/text only/)
    const silent: StreamChunk[] = [{ type: 'finish', reason: { kind: 'stop' } }]
    await expect(runEvaluator(fakeLlm(silent), ROUTE, input())).rejects.toThrow(/no text/)
  })

  it('honors caller cancellation', async () => {
    await expect(runEvaluator(fakeLlm(textChunks(VALID_PROPOSAL_JSON)), ROUTE, input(), AbortSignal.abort())).rejects.toThrow()
  })
})
