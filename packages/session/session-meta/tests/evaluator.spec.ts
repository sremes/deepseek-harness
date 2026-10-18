import { describe, expect, it } from 'vitest'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import type { EvaluatorLlm } from '../src/evaluator.ts'
import { buildEvaluatorPrompt, parseDualProposals, parseProposal, runDualEvaluator, runEvaluator } from '../src/evaluator.ts'
import { makeAggregate, textChunks, toolCallChunks, VALID_PROPOSAL_JSON } from './helpers.ts'
import { projectSession } from '../src/projection.ts'

const ROUTE = { provider: 'flash', model: 'flash-1', maxInputBytes: 12000, maxOutputTokens: 2000, timeoutMs: 5000 }

function fakeLlm(chunks: readonly StreamChunk[], seen?: { provider?: string; model?: string; sessionId?: string }): EvaluatorLlm {
  return {
    async *stream(options: Parameters<EvaluatorLlm['stream']>[0]): AsyncIterable<StreamChunk> {
      if (seen !== undefined) {
        seen.provider = options.provider
        seen.model = options.model
        if (options.sessionId !== undefined) seen.sessionId = options.sessionId
      }
      yield* chunks
    },
  }
}

function input(intentHint?: string) {
  const aggregate = makeAggregate('s1')
  aggregate.openingTask = 'do x'
  return {
    sessionId: 's1',
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

  it('carries outcome, consulted skills, and known signatures', () => {
    const aggregate = makeAggregate('s1')
    aggregate.openingTask = 'do x'
    aggregate.toolSteps.push({ tool: 'edit', ok: true, args: '{"a":1}' })
    aggregate.skillsConsulted.push('triage')
    aggregate.turnEndReason = JSON.stringify({ kind: 'completed' })
    const prompt = JSON.parse(
      buildEvaluatorPrompt({ sessionId: 's1', projection: projectSession(aggregate), steering: [], knownSignatures: ['old-draft'] }),
    ) as Record<string, unknown>
    expect(prompt.completed).toBe(true)
    expect(prompt.skills_consulted).toEqual(['triage'])
    expect(prompt.known_signatures).toEqual(['old-draft'])
    expect((prompt.steps as Array<Record<string, unknown>>)[0]).toMatchObject({ tool: 'edit', args: '{"a":1}' })
  })

  it('defaults known signatures to empty', () => {
    const prompt = JSON.parse(buildEvaluatorPrompt(input())) as { known_signatures: unknown }
    expect(prompt.known_signatures).toEqual([])
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
    [
      JSON.stringify({ intent: 'x', forbidden: [], prescribed: ['p'], trigger_signature: 't', platform: 'p' }),
      /non-empty trigger_conditions/,
    ],
    [
      JSON.stringify({ intent: 'x', forbidden: [], prescribed: ['p'], trigger_signature: 't', platform: 'p', trigger_conditions: '  ' }),
      /non-empty trigger_conditions/,
    ],
  ])('rejects %s', (text, pattern) => {
    expect(() => parseProposal(text)).toThrow(pattern)
  })

  it('rejects malformed JSON inside braces', () => {
    expect(() => parseProposal('{not valid json}')).toThrow(/not valid JSON/)
  })

  it('allows empty prescribed only for uncompleted sessions', () => {
    const base = {
      intent: 'x',
      forbidden: ['f'],
      trigger_signature: 't',
      trigger_conditions: 'c',
      platform: 'p',
      evidence: ['step 1: `rm` called without confirmation flags'],
    }
    expect(() => parseProposal(JSON.stringify({ ...base, prescribed: [] }))).toThrow(/prescribed must be a non-empty/)
    expect(parseProposal(JSON.stringify({ ...base, prescribed: [] }), false).prescribed).toEqual([])
    expect(parseProposal(JSON.stringify({ ...base, prescribed: ['p'] }), false).prescribed).toEqual(['p'])
  })
})

describe('parseProposal evidence and no_contrast', () => {
  const base = {
    intent: 'Confirm destructive paths before running them',
    forbidden: ['Never run rm -rf on unconfirmed paths'],
    prescribed: ['Echo the resolved `path` and wait for confirmation'],
    trigger_signature: 'destructive-path-confirm',
    trigger_conditions: 'Use when a task deletes or overwrites paths outside a scratch directory',
    platform: 'dsh-headless',
  }
  const evidence = ['step 1: `rm` called without confirmation flags', 'step 3: retryArgs added --dry-run']

  it('accepts a proposal with step-cited evidence', () => {
    const proposal = parseProposal(JSON.stringify({ ...base, evidence }))
    expect(proposal.evidence).toEqual(evidence)
    expect(proposal.noContrast).toBeUndefined()
  })

  it('rejects missing evidence', () => {
    expect(() => parseProposal(JSON.stringify(base))).toThrow(/evidence/)
  })

  it('rejects empty evidence entries', () => {
    expect(() => parseProposal(JSON.stringify({ ...base, evidence: [] }))).toThrow(/evidence/)
    expect(() => parseProposal(JSON.stringify({ ...base, evidence: [''] }))).toThrow(/evidence/)
    expect(() => parseProposal(JSON.stringify({ ...base, evidence: [evidence.join('; '), '  '] }))).toThrow(/evidence/)
    expect(() => parseProposal(JSON.stringify({ ...base, evidence: ['step 1: `rm` called', 7] }))).toThrow(/evidence/)
  })

  it('rejects empty prescribed without no_contrast', () => {
    expect(() => parseProposal(JSON.stringify({ ...base, prescribed: [], evidence }))).toThrow(/prescribed must be a non-empty/)
  })

  it('accepts empty prescribed with no_contrast true', () => {
    const proposal = parseProposal(JSON.stringify({ ...base, prescribed: [], evidence, no_contrast: true }))
    expect(proposal.prescribed).toEqual([])
    expect(proposal.noContrast).toBe(true)
  })

  it('rejects garbage no_contrast types', () => {
    expect(() => parseProposal(JSON.stringify({ ...base, evidence, no_contrast: 'yes' }))).toThrow(/no_contrast/)
    expect(() => parseProposal(JSON.stringify({ ...base, evidence, no_contrast: 1 }))).toThrow(/no_contrast/)
  })
})

describe('runEvaluator', () => {
  it('returns the validated proposal with measured usage on the routed model', async () => {
    const seen: { provider?: string; model?: string; sessionId?: string } = {}
    const result = await runEvaluator(fakeLlm(textChunks(VALID_PROPOSAL_JSON, { inputTokens: 11, outputTokens: 22 }), seen), ROUTE, input())
    expect(result.proposal.triggerSignature).toBe('destructive-path-confirm')
    expect(result.inputTokens).toBe(11)
    expect(result.outputTokens).toBe(22)
    expect(seen).toEqual({ provider: 'flash', model: 'flash-1', sessionId: 's1' })
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

describe('parseDualProposals', () => {
  const INVARIANT = {
    intent: 'Restate delegation targets before running them',
    forbidden: ['Never delegate a destructive step without restating its target'],
    prescribed: ['Echo the resolved `path` before delegating the `rm` step'],
    trigger_signature: 'general-unverified-delegation',
    trigger_conditions: 'Use when a session delegates tool calls past an uncertain point',
    platform: 'dsh-headless',
    evidence: ['step 2: delegated `rm` without restating the target path'],
  }
  const DOMAIN = JSON.parse(VALID_PROPOSAL_JSON) as Record<string, unknown>
  const dual = (invariant: unknown, domain: unknown): string => JSON.stringify({ invariant, domain })

  it('parses a dual reply with independent evidence per lens', () => {
    const parsed = parseDualProposals(dual(INVARIANT, DOMAIN))
    expect(parsed.invariant?.triggerSignature).toBe('general-unverified-delegation')
    expect(parsed.domain?.triggerSignature).toBe('destructive-path-confirm')
    expect(parsed.invariant?.evidence).toEqual(INVARIANT.evidence)
    expect(parsed.domain?.evidence).toEqual(DOMAIN.evidence)
  })

  it('declines missing and null lenses', () => {
    expect(parseDualProposals('{}')).toEqual({ invariant: null, domain: null })
    expect(parseDualProposals(dual(null, DOMAIN)).invariant).toBeNull()
    expect(parseDualProposals(dual(null, DOMAIN)).domain?.triggerSignature).toBe('destructive-path-confirm')
    expect(parseDualProposals(JSON.stringify({ domain: DOMAIN })).invariant).toBeNull()
  })

  it('declines lenses with no_contrast true, bare or schema-valid', () => {
    expect(parseDualProposals(dual({ no_contrast: true }, DOMAIN)).invariant).toBeNull()
    expect(parseDualProposals(dual({ ...INVARIANT, prescribed: [], no_contrast: true }, DOMAIN)).invariant).toBeNull()
  })

  it('rejects a legacy single-proposal shape as a dual reply', () => {
    expect(() => parseDualProposals(VALID_PROPOSAL_JSON)).toThrow(/single proposal/)
  })

  it('rejects non-object lenses and schema-invalid lens objects', () => {
    expect(() => parseDualProposals(dual('oops', DOMAIN))).toThrow(/invariant lens must be an object or null/)
    expect(() => parseDualProposals(dual([], DOMAIN))).toThrow(/invariant lens must be an object or null/)
    expect(() => parseDualProposals(dual(INVARIANT, 42))).toThrow(/domain lens must be an object or null/)
    expect(() => parseDualProposals(dual({ intent: 'x' }, DOMAIN))).toThrow(/forbidden/)
    expect(() => parseDualProposals('{not valid json}')).toThrow(/not valid JSON/)
    expect(() => parseDualProposals('[1, 2]')).toThrow(/must be a single JSON object/)
  })

  it('rejects an invariant lens without the general- prefix', () => {
    expect(() => parseDualProposals(dual({ ...INVARIANT, trigger_signature: 'unverified-delegation' }, DOMAIN))).toThrow(/general-/)
  })

  it('rejects a lens that omits evidence while the other lens cites its own', () => {
    const { evidence: _omitted, ...withoutEvidence } = INVARIANT
    expect(_omitted).toHaveLength(1)
    expect(() => parseDualProposals(dual(withoutEvidence, DOMAIN))).toThrow(/evidence/)
  })

  it('accepts a citation duplicated into each lens evidence array', () => {
    const shared = 'step 1: `rm` called without confirmation flags'
    const both = {
      ...INVARIANT,
      evidence: [...INVARIANT.evidence, shared],
    }
    const andDomain = {
      ...DOMAIN,
      evidence: [...(DOMAIN.evidence as string[]), shared],
    }
    const parsed = parseDualProposals(dual(both, andDomain))
    expect(parsed.invariant?.evidence).toContain(shared)
    expect(parsed.domain?.evidence).toContain(shared)
  })

  it('rejects garbage no_contrast types per lens', () => {
    expect(() => parseDualProposals(dual({ ...INVARIANT, no_contrast: 'yes' }, DOMAIN))).toThrow(/no_contrast/)
  })

  it('honors completed=false per lens', () => {
    const parsed = parseDualProposals(dual(INVARIANT, { ...DOMAIN, prescribed: [] }), false)
    expect(parsed.domain?.prescribed).toEqual([])
  })
})

describe('runDualEvaluator', () => {
  it('returns both validated lens proposals with measured usage', async () => {
    const text = JSON.stringify({
      invariant: {
        intent: 'Restate delegation targets before running them',
        forbidden: ['Never delegate a destructive step without restating its target'],
        prescribed: ['Echo the resolved `path` before delegating the `rm` step'],
        trigger_signature: 'general-unverified-delegation',
        trigger_conditions: 'Use when a session delegates tool calls past an uncertain point',
        platform: 'dsh-headless',
        evidence: ['step 2: delegated `rm` without restating the target path'],
      },
      domain: JSON.parse(VALID_PROPOSAL_JSON) as Record<string, unknown>,
    })
    const result = await runDualEvaluator(fakeLlm(textChunks(text, { inputTokens: 7, outputTokens: 8 })), ROUTE, input())
    expect(result.invariant?.triggerSignature).toBe('general-unverified-delegation')
    expect(result.domain?.triggerSignature).toBe('destructive-path-confirm')
    expect(result.inputTokens).toBe(7)
    expect(result.outputTokens).toBe(8)
  })
})
