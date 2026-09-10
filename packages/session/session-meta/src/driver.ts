/**
 * Post-hoc steering driver (Plan-V1 loop closure): runs records written to
 * `$DSH_HOME/meta/steering/*.json` after their session exited through the
 * full Track A pipeline. The live path only sees steering files while the
 * session's process is alive, so headless one-shot records would otherwise
 * sit unread forever. The driver reuses the exact live gates
 * (`shouldEvaluateTrackA` with an explicit-file route bypass,
 * `evaluateTrackASession` which loads the file itself) — background
 * evaluations differ from live ones only in trigger, never in standards.
 *
 * Consumption rules: a record moves to `processed/` once its fate is final
 * (evaluated, rejected as invalid/trivial, or already evaluated). Transient
 * states leave the file in place for the next drive (missing aggregate, LLM
 * failure, absent LLM service). A spent daily budget stops the whole drive —
 * later files wait for the next window instead of ledgering refusals.
 *
 * @module @deepseek-ai/dsh-session-meta/driver
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import type { EvaluatorLlm } from './evaluator.ts'
import { evaluateTrackASession, shouldEvaluateTrackA, type EvaluationConfig } from './orchestrate.ts'
import { parseSteeringFile, processedSteeringDir } from './steering.ts'
import type { MetaStore } from './store.ts'

/** Runtime dependencies of one steering drive. */
export interface SteeringDriveDeps {
  readonly store: MetaStore
  readonly llm: EvaluatorLlm | undefined
  readonly now: () => number
  readonly log: (message: string) => void
}

/** One record the drive consumed without evaluating. */
export interface SteeringDriveSkip {
  readonly sessionId: string
  readonly reason: string
}

/** Outcome of one steering drive. */
export interface SteeringDriveResult {
  readonly evaluated: number
  readonly skipped: readonly SteeringDriveSkip[]
  readonly stoppedOnBudget: boolean
}

/** Directory holding unconsumed steering records. */
function pendingSteeringDir(home: string): string {
  return join(home, 'meta', 'steering')
}

/** Mark one record consumed (final fate — never applied twice). Idempotent:
 * the evaluator itself moves the file on success, so a missing source means
 * the goal state already holds. */
function consumeRecord(home: string, sessionId: string): void {
  const source = join(pendingSteeringDir(home), `${sessionId}.json`)
  if (!existsSync(source)) return
  const processedDir = processedSteeringDir(home)
  mkdirSync(processedDir, { recursive: true })
  renameSync(source, join(processedDir, `${sessionId}.json`))
}

/**
 * Drive every pending steering record through the Track A pipeline.
 * Failures resolve to skips, never rejections — a broken record must not
 * abort the records behind it.
 *
 * @param home - resolved harness home holding `meta/steering/`.
 * @param config - Track A evaluation settings (same object the live path uses).
 * @param deps - store, optional LLM service, clock, and log sink.
 * @returns counts of evaluated records, per-record skips, and budget stop.
 */
export async function drivePendingSteering(
  home: string,
  config: EvaluationConfig,
  deps: SteeringDriveDeps,
): Promise<SteeringDriveResult> {
  const skipped: Array<{ sessionId: string; reason: string }> = []
  let evaluated = 0
  let entries: Array<{ name: string; isFile: boolean }>
  try {
    entries = readdirSync(pendingSteeringDir(home), { withFileTypes: true })
      .map(entry => ({ name: entry.name, isFile: entry.isFile() }))
  } catch {
    return { evaluated: 0, skipped: [], stoppedOnBudget: false }
  }
  const pending = entries
    .filter(entry => entry.isFile && entry.name.endsWith('.json'))
    .map(entry => entry.name)
    .sort()
  for (const name of pending) {
    const sessionId = name.slice(0, -'.json'.length)
    if (sessionId.length === 0) {
      deps.log('session-meta: driver ignoring unnamed steering record')
      continue
    }
    let raw: unknown
    try {
      raw = JSON.parse(readFileSync(join(pendingSteeringDir(home), name), 'utf8'))
    } catch {
      consumeRecord(home, sessionId)
      deps.log(`session-meta: driver consumed invalid JSON steering record for ${sessionId}`)
      skipped.push({ sessionId, reason: 'invalid-json' })
      continue
    }
    try {
      parseSteeringFile(sessionId, raw)
    } catch (error) {
      consumeRecord(home, sessionId)
      deps.log(`session-meta: driver consumed invalid steering record for ${sessionId}: ${String(error)}`)
      skipped.push({ sessionId, reason: 'invalid-record' })
      continue
    }
    if (deps.store.hasEvaluation(sessionId)) {
      consumeRecord(home, sessionId)
      deps.log(`session-meta: driver skipping already-evaluated ${sessionId}`)
      skipped.push({ sessionId, reason: 'already-evaluated' })
      continue
    }
    const aggregate = deps.store.readAggregate(sessionId)
    if (aggregate === undefined) {
      // Pre-v8 session (no cached aggregate): leave the file — a future
      // drive after a re-finalize may still pick it up.
      deps.log(`session-meta: driver deferring ${sessionId} (no cached aggregate)`)
      skipped.push({ sessionId, reason: 'no-aggregate' })
      continue
    }
    // Explicit file steering bypasses the route gate (the record IS the
    // steering signal triage never saw) but keeps the effort gate: a
    // correction on a session where nothing happened teaches nothing.
    if (!shouldEvaluateTrackA('track_a', config.enabled, aggregate, true, config)) {
      consumeRecord(home, sessionId)
      deps.log(`session-meta: driver skipping trivial ${sessionId}`)
      skipped.push({ sessionId, reason: 'trivial' })
      continue
    }
    const outcome = await evaluateTrackASession(
      { store: deps.store, home, llm: deps.llm, replayRunner: undefined, now: deps.now, log: deps.log },
      config,
      aggregate,
    )
    if (outcome.decision === 'budget-refused') {
      return { evaluated, skipped, stoppedOnBudget: true }
    }
    if (outcome.decision === 'llm-error' || outcome.decision === 'skipped:no-llm') {
      // Transient: the LLM service or route may recover by the next drive.
      deps.log(`session-meta: driver deferring ${sessionId} (${outcome.decision})`)
      skipped.push({ sessionId, reason: outcome.decision })
      continue
    }
    consumeRecord(home, sessionId)
    evaluated += 1
  }
  return { evaluated, skipped, stoppedOnBudget: false }
}
