/**
 * Post-hoc steering driver slice: pending records drive the full Track A
 * pipeline after their session exited. Covers every consumption fate —
 * evaluated, transient deferrals, final rejections, and the budget stop.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import type { EvaluatorLlm } from '../src/evaluator.ts'
import { drivePendingSteering } from '../src/driver.ts'
import type { EvaluationConfig } from '../src/orchestrate.ts'
import { MetaStore } from '../src/store.ts'
import { makeAggregate, textChunks, VALID_PROPOSAL_JSON } from './helpers.ts'

const CONFIG: EvaluationConfig = {
  enabled: true,
  provider: 'flash',
  model: 'flash-1',
  maxInputBytes: 12000,
  maxOutputTokens: 2000,
  timeoutMs: 5000,
  maxCallsPerDay: 10,
  maxReplaysPerDay: 8,
  minEvalToolCalls: 3,
  earlySteeringMessages: 1,
  maxPromotionsPerWeek: 3,
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
  root = await mkdtemp(join(tmpdir(), 'dsh-driver-'))
  if (root === undefined) throw new Error('tmp root missing')
  const home: string = root
  store = new MetaStore({ dbPath: ':memory:' })
  return home
}

function deps(home: string, llm: EvaluatorLlm | undefined, logs: string[]) {
  if (store === undefined) throw new Error('store missing')
  return { store, llm, now: () => Date.UTC(2026, 8, 4, 12, 0, 0), log: (message: string) => { logs.push(message) } }
}

function steeringDir(home: string): string {
  return join(home, 'meta', 'steering')
}

function writeRecord(home: string, sessionId: string, raw: unknown): void {
  mkdirSync(steeringDir(home), { recursive: true })
  writeFileSync(join(steeringDir(home), `${sessionId}.json`), typeof raw === 'string' ? raw : JSON.stringify(raw))
}

function validRecord() {
  return { original_task: 'Summarize the inbox', correction: 'Read every thread before summarizing', verified_by: 'review' }
}

/** Cached aggregate with enough substance to pass the effort gate. */
function seedSubstantial(sessionId: string) {
  if (store === undefined) throw new Error('store missing')
  const aggregate = makeAggregate(sessionId)
  aggregate.toolCalls = 5
  aggregate.steeringTexts.push('not like that')
  store.writeAggregate(sessionId, aggregate)
}

function pendingNames(home: string): string[] {
  try {
    return readdirSync(steeringDir(home)).filter(name => name.endsWith('.json')).sort()
  } catch {
    return []
  }
}

function processedNames(home: string): string[] {
  try {
    return readdirSync(join(steeringDir(home), 'processed')).filter(name => name.endsWith('.json')).sort()
  } catch {
    return []
  }
}

/** Fake llm serving the valid proposal on every call. */
function okLlm(): EvaluatorLlm {
  const chunks = textChunks(VALID_PROPOSAL_JSON, { inputTokens: 5, outputTokens: 6 })
  return {
    async *stream(): AsyncIterable<StreamChunk> {
      yield* chunks
    },
  }
}

function throwingLlm(): EvaluatorLlm {
  return {
    async *stream(): AsyncIterable<StreamChunk> {
      throw new Error('route down')
      yield* []
    },
  }
}

describe('drivePendingSteering', () => {
  it('evaluates a valid record end to end and consumes it', async () => {
    const home = await freshHome()
    // Weekly promotion cap pre-filled so the outcome holds at probation
    // deterministically (no replay runner in the background drive).
    store?.recordPromotion('cap-sig-1', 'cap-slug-1')
    store?.recordPromotion('cap-sig-2', 'cap-slug-2')
    store?.recordPromotion('cap-sig-3', 'cap-slug-3')
    writeRecord(home, 's1', validRecord())
    seedSubstantial('s1')
    const logs: string[] = []
    const result = await drivePendingSteering(home, { ...CONFIG, skillsDir: join(home, 'skills') }, deps(home, okLlm(), logs))
    expect(result).toEqual({ evaluated: 1, skipped: [], stoppedOnBudget: false })
    expect(pendingNames(home)).toEqual([])
    expect(processedNames(home)).toEqual(['s1.json'])
    expect(store?.hasEvaluation('s1')).toBe(true)
    expect(existsSync(join(home, 'skills', 'destructive-path-confirm', 'SKILL.md'))).toBe(true)
  })

  it('defers the record on evaluator failure and leaves it pending', async () => {
    const home = await freshHome()
    writeRecord(home, 's1', validRecord())
    seedSubstantial('s1')
    const logs: string[] = []
    const result = await drivePendingSteering(home, { ...CONFIG, skillsDir: join(home, 'skills') }, deps(home, throwingLlm(), logs))
    expect(result.evaluated).toBe(0)
    expect(result.stoppedOnBudget).toBe(false)
    expect(result.skipped).toEqual([{ sessionId: 's1', reason: 'llm-error' }])
    expect(pendingNames(home)).toEqual(['s1.json'])
    expect(processedNames(home)).toEqual([])
  })

  it('stops the drive on a spent daily budget and leaves files pending', async () => {
    const home = await freshHome()
    writeRecord(home, 's1', validRecord())
    writeRecord(home, 's2', validRecord())
    seedSubstantial('s1')
    seedSubstantial('s2')
    const logs: string[] = []
    const result = await drivePendingSteering(home, { ...CONFIG, maxCallsPerDay: 0, skillsDir: join(home, 'skills') }, deps(home, okLlm(), logs))
    expect(result).toEqual({ evaluated: 0, skipped: [], stoppedOnBudget: true })
    expect(pendingNames(home)).toEqual(['s1.json', 's2.json'])
  })

  it('consumes an already-evaluated record without calling the llm', async () => {
    const home = await freshHome()
    writeRecord(home, 's1', validRecord())
    seedSubstantial('s1')
    store?.recordEvaluation({ ts: Date.UTC(2026, 8, 4, 6, 0, 0), sessionId: 's1', inputTokens: 1, outputTokens: 1, decision: 'draft-written', draftSlug: 'x' })
    let calls = 0
    const counting: EvaluatorLlm = {
      async *stream(): AsyncIterable<StreamChunk> {
        calls += 1
        yield* []
      },
    }
    const logs: string[] = []
    const result = await drivePendingSteering(home, { ...CONFIG, skillsDir: join(home, 'skills') }, deps(home, counting, logs))
    expect(calls).toBe(0)
    expect(result).toEqual({ evaluated: 0, skipped: [{ sessionId: 's1', reason: 'already-evaluated' }], stoppedOnBudget: false })
    expect(processedNames(home)).toEqual(['s1.json'])
  })

  it('consumes invalid JSON without evaluating', async () => {
    const home = await freshHome()
    writeRecord(home, 's1', '{not-json')
    const logs: string[] = []
    const result = await drivePendingSteering(home, { ...CONFIG, skillsDir: join(home, 'skills') }, deps(home, okLlm(), logs))
    expect(result).toEqual({ evaluated: 0, skipped: [{ sessionId: 's1', reason: 'invalid-json' }], stoppedOnBudget: false })
    expect(processedNames(home)).toEqual(['s1.json'])
  })

  it('consumes a schema-invalid record without evaluating', async () => {
    const home = await freshHome()
    writeRecord(home, 's1', { original_task: 'Summarize the inbox', correction: '   ' })
    const logs: string[] = []
    const result = await drivePendingSteering(home, { ...CONFIG, skillsDir: join(home, 'skills') }, deps(home, okLlm(), logs))
    expect(result).toEqual({ evaluated: 0, skipped: [{ sessionId: 's1', reason: 'invalid-record' }], stoppedOnBudget: false })
    expect(processedNames(home)).toEqual(['s1.json'])
  })

  it('defers a record with no cached aggregate and leaves it pending', async () => {
    const home = await freshHome()
    writeRecord(home, 's1', validRecord())
    const logs: string[] = []
    const result = await drivePendingSteering(home, { ...CONFIG, skillsDir: join(home, 'skills') }, deps(home, okLlm(), logs))
    expect(result).toEqual({ evaluated: 0, skipped: [{ sessionId: 's1', reason: 'no-aggregate' }], stoppedOnBudget: false })
    expect(pendingNames(home)).toEqual(['s1.json'])
  })

  it('consumes a trivial record without spending an evaluation', async () => {
    const home = await freshHome()
    writeRecord(home, 's1', validRecord())
    if (store === undefined) throw new Error('store missing')
    store.writeAggregate('s1', makeAggregate('s1'))
    let calls = 0
    const counting: EvaluatorLlm = {
      async *stream(): AsyncIterable<StreamChunk> {
        calls += 1
        yield* []
      },
    }
    const logs: string[] = []
    const result = await drivePendingSteering(home, { ...CONFIG, skillsDir: join(home, 'skills') }, deps(home, counting, logs))
    expect(calls).toBe(0)
    expect(result).toEqual({ evaluated: 0, skipped: [{ sessionId: 's1', reason: 'trivial' }], stoppedOnBudget: false })
    expect(processedNames(home)).toEqual(['s1.json'])
  })

  it('defers the record without an llm service and leaves it pending', async () => {
    const home = await freshHome()
    writeRecord(home, 's1', validRecord())
    seedSubstantial('s1')
    const logs: string[] = []
    const result = await drivePendingSteering(home, { ...CONFIG, skillsDir: join(home, 'skills') }, deps(home, undefined, logs))
    expect(result).toEqual({ evaluated: 0, skipped: [{ sessionId: 's1', reason: 'skipped:no-llm' }], stoppedOnBudget: false })
    expect(pendingNames(home)).toEqual(['s1.json'])
  })

  it('returns zeros when the steering directory is absent', async () => {
    const home = await freshHome()
    const logs: string[] = []
    await expect(drivePendingSteering(home, { ...CONFIG, skillsDir: join(home, 'skills') }, deps(home, okLlm(), logs))).resolves.toEqual({
      evaluated: 0,
      skipped: [],
      stoppedOnBudget: false,
    })
  })

  it('ignores non-record files and the processed directory', async () => {
    const home = await freshHome()
    mkdirSync(steeringDir(home), { recursive: true })
    writeFileSync(join(steeringDir(home), 'notes.txt'), 'not a record')
    mkdirSync(join(steeringDir(home), 'processed'), { recursive: true })
    writeFileSync(join(steeringDir(home), 'processed', 'old.json'), JSON.stringify(validRecord()))
    const logs: string[] = []
    const result = await drivePendingSteering(home, { ...CONFIG, skillsDir: join(home, 'skills') }, deps(home, okLlm(), logs))
    expect(result).toEqual({ evaluated: 0, skipped: [], stoppedOnBudget: false })
    expect(existsSync(join(steeringDir(home), 'notes.txt'))).toBe(true)
    expect(existsSync(join(steeringDir(home), 'processed', 'old.json'))).toBe(true)
  })

  it('ignores an unnamed record file without consuming it', async () => {
    const home = await freshHome()
    mkdirSync(steeringDir(home), { recursive: true })
    writeFileSync(join(steeringDir(home), '.json'), JSON.stringify(validRecord()))
    const logs: string[] = []
    const result = await drivePendingSteering(home, { ...CONFIG, skillsDir: join(home, 'skills') }, deps(home, okLlm(), logs))
    expect(result).toEqual({ evaluated: 0, skipped: [], stoppedOnBudget: false })
    expect(existsSync(join(steeringDir(home), '.json'))).toBe(true)
  })
})

describe('hasEvaluation', () => {
  it('is false before and true after a ledger row', async () => {
    await freshHome()
    if (store === undefined) throw new Error('store missing')
    expect(store.hasEvaluation('s1')).toBe(false)
    store.recordEvaluation({ ts: Date.UTC(2026, 8, 4, 6, 0, 0), sessionId: 's1', inputTokens: 1, outputTokens: 1, decision: 'llm-error', draftSlug: null })
    expect(store.hasEvaluation('s1')).toBe(true)
    expect(store.hasEvaluation('s2')).toBe(false)
  })
})
