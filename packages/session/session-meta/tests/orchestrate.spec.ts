import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import type { EvaluatorLlm } from '../src/evaluator.ts'
import {
  evaluateTrackASession,
  hasSteeringFile,
  listKnownSignatures,
  loadSteeringFile,
  startOfUtcDay,
  type EvaluationConfig,
} from '../src/orchestrate.ts'
import { steeringFilePath } from '../src/steering.ts'
import { MetaStore } from '../src/store.ts'
import { FakeReplayRunner } from '../src/replay.ts'
import type { ReplayOutcome, ReplayRunner } from '../src/replay.ts'
import { makeAggregate, textChunks, VALID_PROPOSAL_JSON } from './helpers.ts'

const CONFIG: EvaluationConfig = {
  enabled: true,
  provider: 'flash',
  model: 'flash-1',
  maxInputBytes: 12000,
  maxOutputTokens: 2000,
  timeoutMs: 5000,
  maxCallsPerDay: 1,
  maxReplaysPerDay: 8,
  minEvalToolCalls: 3,
  earlySteeringMessages: 1,
  skillsDir: '',
}

let root: string | undefined
let store: MetaStore | undefined

afterEach(async () => {
  store?.close()
  store = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

async function freshHome(): Promise<string> {
  root = await mkdtemp(join(tmpdir(), 'dsh-track-a-'))
  if (root === undefined) throw new Error('tmp root missing')
  const home: string = root
  store = new MetaStore({ dbPath: ':memory:' })
  return home
}

function deps(home: string, llm: EvaluatorLlm | undefined, logs: string[], runner?: ReplayRunner) {
  if (store === undefined) throw new Error('store missing')
  return { store, home, llm, replayRunner: runner, now: () => Date.UTC(2026, 8, 4, 12, 0, 0), log: (message: string) => { logs.push(message) } }
}

/** Aggregate carrying steering plus a replayable opening task. */
function l2Aggregate(sessionId: string) {
  const aggregate = makeAggregate(sessionId)
  aggregate.steeringTexts.push('not like that')
  aggregate.openingTask = 'Confirm the destructive path before running it'
  return aggregate
}

/** Replay outcome baseline; tests override the fields their veto needs. */
function replayOutcome(overrides?: Partial<ReplayOutcome>): ReplayOutcome {
  return {
    completed: true,
    turnEnd: 'completed',
    steeringCount: 0,
    toolCalls: 5,
    summary: 'Ran the checks; all green.',
    ...overrides,
  }
}

/** Fake llm serving the valid proposal first, then two candidate-preferring judge verdicts. */
function judgePassLlm(): EvaluatorLlm {
  const runs = [
    textChunks(VALID_PROPOSAL_JSON, { inputTokens: 5, outputTokens: 6 }),
    textChunks(JSON.stringify({ verdict: 'prefer-a', grounds: 'Candidate retried `path` and the result shows ok' })),
    textChunks(JSON.stringify({ verdict: 'prefer-b', grounds: 'Candidate retried `path` and the result shows ok' })),
  ]
  let calls = 0
  return {
    async *stream(): AsyncIterable<StreamChunk> {
      const chunks = runs[calls] ?? []
      calls += 1
      yield* chunks
    },
  }
}

/** Fake llm serving the valid proposal, then the given judge verdicts in order. */
function scriptedJudgeLlm(verdicts: readonly string[]): EvaluatorLlm {
  const runs = [
    textChunks(VALID_PROPOSAL_JSON, { inputTokens: 5, outputTokens: 6 }),
    ...verdicts.map(verdict =>
      textChunks(JSON.stringify({ verdict, grounds: 'Candidate retried `path` and the result shows ok' })),
    ),
  ]
  let calls = 0
  return {
    async *stream(): AsyncIterable<StreamChunk> {
      const chunks = runs[calls] ?? []
      calls += 1
      yield* chunks
    },
  }
}

/** Seed one past promoted session for the L3 gate (signature matches VALID_PROPOSAL_JSON). */
function seedHistory(sessionId: string, taskInput: string, ts: number): void {
  if (store === undefined) throw new Error('store missing')
  store.recordPromotionSession('destructive-path-confirm', sessionId, taskInput, ts)
}

function okLlm(): EvaluatorLlm {
  const chunks = textChunks(VALID_PROPOSAL_JSON, { inputTokens: 5, outputTokens: 6 })
  return {
    async *stream(): AsyncIterable<StreamChunk> {
      yield* chunks
    },
  }
}

/** Evaluator output whose draft passes L0 but holds no checkable Prescribed clause. */
function l1FailingLlm(): EvaluatorLlm {
  const vague = JSON.stringify({
    intent: 'Double-check before proceeding',
    forbidden: [],
    prescribed: ['Always double-check before proceeding'],
    trigger_signature: 'double-check-habit',
    trigger_conditions: 'Use when a task proceeds past an uncertain point',
    platform: 'dsh-headless',
  })
  const chunks = textChunks(vague, { inputTokens: 5, outputTokens: 6 })
  return {
    async *stream(): AsyncIterable<StreamChunk> {
      yield* chunks
    },
  }
}

/** Evaluator output whose draft trips L0 bans (PR ref + negative-capability claim). */
function l0FailingLlm(): EvaluatorLlm {
  const bad = JSON.stringify({
    intent: 'Reuse the incident helper',
    forbidden: [],
    prescribed: ['Reuse the helper from PR #12345 because the old tool is unusable'],
    trigger_signature: 'incident-helper-reuse',
    trigger_conditions: 'Use when the incident helper applies',
    platform: 'dsh-headless',
  })
  const chunks = textChunks(bad, { inputTokens: 5, outputTokens: 6 })
  return {
    async *stream(): AsyncIterable<StreamChunk> {
      yield* chunks
    },
  }
}

describe('startOfUtcDay', () => {
  it('truncates to UTC midnight', () => {
    expect(startOfUtcDay(Date.UTC(2026, 8, 4, 12, 34, 56))).toBe(Date.UTC(2026, 8, 4))
  })
})

describe('listKnownSignatures', () => {
  it('lists skill directories and tolerates missing roots', async () => {
    const home = await freshHome()
    expect(listKnownSignatures(join(home, 'skills'))).toEqual([])
    mkdirSync(join(home, 'skills', 'old-draft'), { recursive: true })
    writeFileSync(join(home, 'skills', 'loose.md'), 'not a dir')
    expect(listKnownSignatures(join(home, 'skills'))).toEqual(['old-draft'])
  })
})

describe('steering file loading', () => {
  it('reports presence without reading', async () => {
    const home = await freshHome()
    expect(hasSteeringFile(home, 's1')).toBe(false)
    mkdirSync(join(home, 'meta', 'steering'), { recursive: true })
    writeFileSync(steeringFilePath(home, 's1'), JSON.stringify({ original_task: 'x', correction: 'y' }))
    expect(hasSteeringFile(home, 's1')).toBe(true)
  })

  it('returns undefined for absent files', async () => {
    const home = await freshHome()
    expect(loadSteeringFile(home, 's1', () => {})).toBeUndefined()
  })

  it('warns on invalid JSON and invalid records', async () => {
    const home = await freshHome()
    mkdirSync(join(home, 'meta', 'steering'), { recursive: true })
    const logs: string[] = []
    const log = (message: string): void => {
      logs.push(message)
    }
    writeFileSync(steeringFilePath(home, 'bad-json'), '{nope')
    expect(loadSteeringFile(home, 'bad-json', log)).toBeUndefined()
    writeFileSync(steeringFilePath(home, 'bad-record'), JSON.stringify({ original_task: 'x' }))
    expect(loadSteeringFile(home, 'bad-record', log)).toBeUndefined()
    expect(logs).toHaveLength(2)
  })

  it('parses a valid record', async () => {
    const home = await freshHome()
    mkdirSync(join(home, 'meta', 'steering'), { recursive: true })
    writeFileSync(steeringFilePath(home, 's1'), JSON.stringify({ original_task: 'x', correction: 'y', intent_hint: 'h' }))
    expect(loadSteeringFile(home, 's1', () => {}))?.toMatchObject({ sessionId: 's1', originalTask: 'x', correction: 'y' })
  })
})

describe('evaluateTrackASession', () => {
  it('skips sessions with no steering content', async () => {
    const home = await freshHome()
    const logs: string[] = []
    const outcome = await evaluateTrackASession(deps(home, okLlm(), logs), { ...CONFIG, skillsDir: home }, makeAggregate('s1'))
    expect(outcome).toEqual({ decision: 'skipped:no-steering', draftSlug: null })
    expect(store?.countEvaluationsSince(0)).toBe(0)
  })

  it('refuses over the daily budget and ledgers the refusal', async () => {
    const home = await freshHome()
    store?.recordEvaluation({ ts: Date.UTC(2026, 8, 4, 6, 0, 0), sessionId: 'older', inputTokens: 1, outputTokens: 1, decision: 'draft-written', draftSlug: 'x' })
    const aggregate = makeAggregate('s1')
    aggregate.steeringTexts.push('not like that')
    const logs: string[] = []
    const outcome = await evaluateTrackASession(deps(home, okLlm(), logs), { ...CONFIG, skillsDir: home }, aggregate)
    expect(outcome.decision).toBe('budget-refused')
    expect(store?.countEvaluationsSince(0)).toBe(2)
  })

  it('skips without an llm service', async () => {
    const home = await freshHome()
    const aggregate = makeAggregate('s1')
    aggregate.steeringTexts.push('not like that')
    const outcome = await evaluateTrackASession(deps(home, undefined, []), { ...CONFIG, skillsDir: home }, aggregate)
    expect(outcome).toEqual({ decision: 'skipped:no-llm', draftSlug: null })
  })

  it('ledgers evaluator failures without throwing', async () => {
    const home = await freshHome()
    const failing: EvaluatorLlm = {
      async *stream(): AsyncIterable<StreamChunk> {
        throw new Error('upstream down')
        yield* []
      },
    }
    const aggregate = makeAggregate('s1')
    aggregate.steeringTexts.push('not like that')
    const logs: string[] = []
    const outcome = await evaluateTrackASession(deps(home, failing, logs), { ...CONFIG, skillsDir: home }, aggregate)
    expect(outcome.decision).toBe('llm-error')
    expect(logs.join('\n')).toMatch(/evaluator failed/)
  })

  it('writes a gated draft, ledgers usage, and consumes the steering file', async () => {
    const home = await freshHome()
    mkdirSync(join(home, 'meta', 'steering'), { recursive: true })
    writeFileSync(steeringFilePath(home, 's1'), JSON.stringify({ original_task: 'do x', correction: 'do y instead' }))
    const skills = join(home, 'skills')
    const aggregate = { ...makeAggregate('s1'), origin: 'headless' as const }
    const logs: string[] = []
    const outcome = await evaluateTrackASession(deps(home, okLlm(), logs), { ...CONFIG, skillsDir: skills }, aggregate)
    expect(outcome).toEqual({ decision: 'draft-written', draftSlug: 'destructive-path-confirm' })
    expect(existsSync(join(skills, 'destructive-path-confirm', 'SKILL.md'))).toBe(true)
    expect(existsSync(steeringFilePath(home, 's1'))).toBe(false)
    expect(existsSync(join(home, 'meta', 'steering', 'processed', 's1.json'))).toBe(true)
    expect(store?.countEvaluationsSince(0)).toBe(1)
  })

  it('writes drafts without a steering file under an unknown mode', async () => {
    const home = await freshHome()
    const skills = join(home, 'skills')
    const aggregate = makeAggregate('s9')
    aggregate.steeringTexts.push('not like that')
    const outcome = await evaluateTrackASession(deps(home, okLlm(), []), { ...CONFIG, skillsDir: skills }, aggregate)
    expect(outcome.decision).toBe('draft-written')
    expect(existsSync(join(skills, 'destructive-path-confirm', 'SKILL.md'))).toBe(true)
  })

  it('vetoes L0-failing drafts before any file lands and ledgers the spend', async () => {
    const home = await freshHome()
    const skills = join(home, 'skills')
    const aggregate = makeAggregate('s1')
    aggregate.steeringTexts.push('not like that')
    const logs: string[] = []
    const outcome = await evaluateTrackASession(deps(home, l0FailingLlm(), logs), { ...CONFIG, skillsDir: skills }, aggregate)
    expect(outcome).toEqual({ decision: 'l0-rejected', draftSlug: null })
    expect(existsSync(join(skills, 'incident-helper-reuse', 'SKILL.md'))).toBe(false)
    expect(logs.join('\n')).toMatch(/L0 contract/)
    expect(store?.countEvaluationsSince(0)).toBe(1)
  })

  it('vetoes L0-passing but L1-failing drafts before any file lands and ledgers the spend', async () => {
    const home = await freshHome()
    const skills = join(home, 'skills')
    const aggregate = makeAggregate('s1')
    aggregate.steeringTexts.push('not like that')
    const logs: string[] = []
    const outcome = await evaluateTrackASession(deps(home, l1FailingLlm(), logs), { ...CONFIG, skillsDir: skills }, aggregate)
    expect(outcome).toEqual({ decision: 'l1-rejected', draftSlug: null })
    expect(existsSync(join(skills, 'double-check-habit', 'SKILL.md'))).toBe(false)
    expect(logs.join('\n')).toMatch(/L1 self-test/)
    expect(store?.countEvaluationsSince(0)).toBe(1)
  })

  it('promotes L2-passing drafts and records both replay runs', async () => {
    const home = await freshHome()
    const skills = join(home, 'skills')
    const runner = new FakeReplayRunner([replayOutcome({}), replayOutcome({})])
    const logs: string[] = []
    const outcome = await evaluateTrackASession(deps(home, judgePassLlm(), logs, runner), { ...CONFIG, skillsDir: skills }, l2Aggregate('s1'))
    expect(outcome).toEqual({ decision: 'draft-written', draftSlug: 'destructive-path-confirm' })
    expect(existsSync(join(skills, 'destructive-path-confirm', 'SKILL.md'))).toBe(true)
    expect(store?.countReplayRunsSince(0)).toBe(2)
    expect(store?.countEvaluationsSince(0)).toBe(1)
  })

  it('vetoes L2-harmed drafts, removes the draft dir, and ledgers the spend', async () => {
    const home = await freshHome()
    const skills = join(home, 'skills')
    const runner = new FakeReplayRunner([
      replayOutcome({ completed: false, turnEnd: 'error' }),
      replayOutcome({ completed: true, turnEnd: 'completed' }),
    ])
    const logs: string[] = []
    const outcome = await evaluateTrackASession(deps(home, judgePassLlm(), logs, runner), { ...CONFIG, skillsDir: skills }, l2Aggregate('s1'))
    expect(outcome).toEqual({ decision: 'l2-rejected', draftSlug: null })
    expect(existsSync(join(skills, 'destructive-path-confirm'))).toBe(false)
    expect(logs.join('\n')).toMatch(/L2 replay/)
    expect(store?.countEvaluationsSince(0)).toBe(1)
  })

  it('vetoes L2 judge failures, removes the draft dir, and ledgers the spend', async () => {
    const home = await freshHome()
    const skills = join(home, 'skills')
    const runner = new FakeReplayRunner([replayOutcome({}), replayOutcome({})])
    const logs: string[] = []
    const outcome = await evaluateTrackASession(deps(home, okLlm(), logs, runner), { ...CONFIG, skillsDir: skills }, l2Aggregate('s1'))
    expect(outcome).toEqual({ decision: 'l2-rejected', draftSlug: null })
    expect(existsSync(join(skills, 'destructive-path-confirm'))).toBe(false)
    expect(logs.join('\n')).toMatch(/L2 judge/)
    expect(store?.countEvaluationsSince(0)).toBe(1)
  })

  it('ledgers replay failures as l2-error and removes the draft dir', async () => {
    const home = await freshHome()
    const skills = join(home, 'skills')
    const runner = new FakeReplayRunner([])
    const logs: string[] = []
    const outcome = await evaluateTrackASession(deps(home, okLlm(), logs, runner), { ...CONFIG, skillsDir: skills }, l2Aggregate('s1'))
    expect(outcome).toEqual({ decision: 'l2-error', draftSlug: null })
    expect(existsSync(join(skills, 'destructive-path-confirm'))).toBe(false)
    expect(logs.join('\n')).toMatch(/replay failed/)
    expect(store?.countEvaluationsSince(0)).toBe(1)
  })

  it('skips L2 over the replay budget and still promotes', async () => {
    const home = await freshHome()
    const skills = join(home, 'skills')
    const runner = new FakeReplayRunner([replayOutcome({}), replayOutcome({})])
    const logs: string[] = []
    const outcome = await evaluateTrackASession(deps(home, okLlm(), logs, runner), { ...CONFIG, skillsDir: skills, maxReplaysPerDay: 1 }, l2Aggregate('s1'))
    expect(outcome).toEqual({ decision: 'draft-written', draftSlug: 'destructive-path-confirm' })
    expect(existsSync(join(skills, 'destructive-path-confirm', 'SKILL.md'))).toBe(true)
    expect(store?.countReplayRunsSince(0)).toBe(0)
    expect(logs.join('\n')).toMatch(/l2 skipped \(replay budget\)/)
  })

  it('skips L2 without task input and still promotes', async () => {
    const home = await freshHome()
    const skills = join(home, 'skills')
    const runner = new FakeReplayRunner([replayOutcome({}), replayOutcome({})])
    const aggregate = makeAggregate('s1')
    aggregate.steeringTexts.push('not like that')
    aggregate.openingTask = '   '
    const logs: string[] = []
    const outcome = await evaluateTrackASession(deps(home, okLlm(), logs, runner), { ...CONFIG, skillsDir: skills }, aggregate)
    expect(outcome).toEqual({ decision: 'draft-written', draftSlug: 'destructive-path-confirm' })
    expect(existsSync(join(skills, 'destructive-path-confirm', 'SKILL.md'))).toBe(true)
    expect(store?.countReplayRunsSince(0)).toBe(0)
    expect(logs.join('\n')).toMatch(/l2 skipped \(no task input\)/)
  })

  it('passes L3 vacuously without history and still promotes', async () => {
    const home = await freshHome()
    const skills = join(home, 'skills')
    const runner = new FakeReplayRunner([replayOutcome({}), replayOutcome({})])
    const logs: string[] = []
    const outcome = await evaluateTrackASession(deps(home, judgePassLlm(), logs, runner), { ...CONFIG, skillsDir: skills }, l2Aggregate('s1'))
    expect(outcome).toEqual({ decision: 'draft-written', draftSlug: 'destructive-path-confirm' })
    expect(existsSync(join(skills, 'destructive-path-confirm', 'SKILL.md'))).toBe(true)
    expect(store?.countReplayRunsSince(0)).toBe(2)
    expect(logs.join('\n')).toMatch(/l3 skipped \(no history\)/)
  })

  it('vetoes L3-harmed drafts on the second pair, removes the draft dir, and ledgers the spend', async () => {
    const home = await freshHome()
    const skills = join(home, 'skills')
    seedHistory('s-old', 'Past task one', 100)
    seedHistory('s-new', 'Past task two', 200)
    const runner = new FakeReplayRunner([
      replayOutcome({}),
      replayOutcome({}),
      replayOutcome({}),
      replayOutcome({}),
      replayOutcome({ completed: false, turnEnd: 'error' }),
      replayOutcome({ completed: true, turnEnd: 'completed' }),
    ])
    const logs: string[] = []
    const outcome = await evaluateTrackASession(
      deps(home, scriptedJudgeLlm(['prefer-a', 'prefer-b', 'prefer-a', 'prefer-b']), logs, runner),
      { ...CONFIG, skillsDir: skills },
      l2Aggregate('s1'),
    )
    expect(outcome).toEqual({ decision: 'l3-rejected', draftSlug: null })
    expect(existsSync(join(skills, 'destructive-path-confirm'))).toBe(false)
    expect(logs.join('\n')).toMatch(/L3 replay/)
    expect(logs.join('\n')).toMatch(/pair 1/)
    expect(store?.countEvaluationsSince(0)).toBe(1)
  })

  it('vetoes L3 judge failures, removes the draft dir, and ledgers the spend', async () => {
    const home = await freshHome()
    const skills = join(home, 'skills')
    seedHistory('s-old', 'Past task one', 100)
    const runner = new FakeReplayRunner([replayOutcome({}), replayOutcome({}), replayOutcome({}), replayOutcome({})])
    const logs: string[] = []
    const outcome = await evaluateTrackASession(
      deps(home, scriptedJudgeLlm(['prefer-a', 'prefer-b', 'prefer-b', 'prefer-a']), logs, runner),
      { ...CONFIG, skillsDir: skills },
      l2Aggregate('s1'),
    )
    expect(outcome).toEqual({ decision: 'l3-rejected', draftSlug: null })
    expect(existsSync(join(skills, 'destructive-path-confirm'))).toBe(false)
    expect(logs.join('\n')).toMatch(/L3 judge/)
    expect(store?.countEvaluationsSince(0)).toBe(1)
  })

  it('ledgers L3 replay failures as l3-error and removes the draft dir', async () => {
    const home = await freshHome()
    const skills = join(home, 'skills')
    seedHistory('s-old', 'Past task one', 100)
    const runner = new FakeReplayRunner([replayOutcome({}), replayOutcome({})])
    const logs: string[] = []
    const outcome = await evaluateTrackASession(deps(home, judgePassLlm(), logs, runner), { ...CONFIG, skillsDir: skills }, l2Aggregate('s1'))
    expect(outcome).toEqual({ decision: 'l3-error', draftSlug: null })
    expect(existsSync(join(skills, 'destructive-path-confirm'))).toBe(false)
    expect(logs.join('\n')).toMatch(/l3 replay failed/)
    expect(store?.countEvaluationsSince(0)).toBe(1)
  })

  it('skips L3 over the replay budget and still promotes', async () => {
    const home = await freshHome()
    const skills = join(home, 'skills')
    seedHistory('s-old', 'Past task one', 100)
    const runner = new FakeReplayRunner([replayOutcome({}), replayOutcome({})])
    const logs: string[] = []
    const outcome = await evaluateTrackASession(deps(home, judgePassLlm(), logs, runner), { ...CONFIG, skillsDir: skills, maxReplaysPerDay: 2 }, l2Aggregate('s1'))
    expect(outcome).toEqual({ decision: 'draft-written', draftSlug: 'destructive-path-confirm' })
    expect(existsSync(join(skills, 'destructive-path-confirm', 'SKILL.md'))).toBe(true)
    expect(store?.countReplayRunsSince(0)).toBe(2)
    expect(logs.join('\n')).toMatch(/l3 skipped \(replay budget\)/)
  })
})
