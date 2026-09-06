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
import { makeAggregate, textChunks, VALID_PROPOSAL_JSON } from './helpers.ts'

const CONFIG: EvaluationConfig = {
  enabled: true,
  provider: 'flash',
  model: 'flash-1',
  maxInputBytes: 12000,
  maxOutputTokens: 2000,
  timeoutMs: 5000,
  maxCallsPerDay: 1,
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

function deps(home: string, llm: EvaluatorLlm | undefined, logs: string[]) {
  if (store === undefined) throw new Error('store missing')
  return { store, home, llm, now: () => Date.UTC(2026, 8, 4, 12, 0, 0), log: (message: string) => { logs.push(message) } }
}

function okLlm(): EvaluatorLlm {
  const chunks = textChunks(VALID_PROPOSAL_JSON, { inputTokens: 5, outputTokens: 6 })
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
})
