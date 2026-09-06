/**
 * Track A offline loop driver (Plan-V1 §3.3/M2): after a steered session
 * finalizes, gather both steering sources, enforce the daily evaluator
 * budget, run the Flash evaluator over the state projection, and persist
 * the proposal as a pipeline-gated skill draft. Every failure is contained
 * and ledgered — the session pipeline never throws into flush/dispose.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import type { EvaluatorLlm, EvaluatorRoute } from './evaluator.ts'
import { runEvaluator } from './evaluator.ts'
import { projectSession as buildProjection } from './projection.ts'
import { redactString } from './redact.ts'
import { parseSteeringFile, processedSteeringDir, steeringFilePath } from './steering.ts'
import type { MetaStore } from './store.ts'
import type { EvaluatorProposal, SessionAggregate, SteeringRecord } from './types.ts'
import { writeSkillDraft } from './writer.ts'

/** Whether a steering file exists for one session (flush-path pre-check). */
export function hasSteeringFile(home: string, sessionId: string): boolean {
  return existsSync(steeringFilePath(home, sessionId))
}

/** Resolved Track A loop settings (from plugin config). */
export interface EvaluationConfig extends EvaluatorRoute {
  readonly enabled: boolean
  readonly maxCallsPerDay: number
  readonly skillsDir: string
}

/** Runtime dependencies of one evaluation. */
export interface EvaluationDeps {
  readonly store: MetaStore
  readonly home: string
  readonly llm: EvaluatorLlm | undefined
  readonly now: () => number
  readonly log: (message: string) => void
}

/** Outcome of one Track A evaluation attempt. */
export interface EvaluationOutcome {
  readonly decision: string
  readonly draftSlug: string | null
}

/** UTC-midnight millis for `now` (the daily budget window). */
export function startOfUtcDay(now: number): number {
  const day = new Date(now)
  day.setUTCHours(0, 0, 0, 0)
  return day.getTime()
}

/**
 * Existing draft slugs under the skill root (cheap dedup hint for the
 * evaluator; unreadable roots yield `[]`, never a failure).
 */
export function listKnownSignatures(skillsDir: string): string[] {
  try {
    return readdirSync(skillsDir, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name)
  } catch {
    return []
  }
}

/**
 * Load and validate one session's steering file. Absent files and invalid
 * content both yield `undefined` (the latter with a warning) — a broken
 * record must never fail the session pipeline.
 */
export function loadSteeringFile(home: string, sessionId: string, log: (message: string) => void): SteeringRecord | undefined {
  const path = steeringFilePath(home, sessionId)
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    log(`session-meta: ignoring invalid JSON steering record for ${sessionId}`)
    return undefined
  }
  try {
    return parseSteeringFile(sessionId, parsed)
  } catch (error) {
    log(`session-meta: ignoring invalid steering record for ${sessionId}: ${String(error)}`)
    return undefined
  }
}

/**
 * Evaluate one finished steered session and write a gated draft.
 * Fire-and-forget from flush/dispose; failures resolve to ledgered
 * decisions, never rejections.
 */
export async function evaluateTrackASession(
  deps: EvaluationDeps,
  config: EvaluationConfig,
  aggregate: SessionAggregate,
): Promise<EvaluationOutcome> {
  const fileRecord = loadSteeringFile(deps.home, aggregate.sessionId, deps.log)
  const steering: SteeringRecord[] = [...(fileRecord === undefined ? [] : [fileRecord])]
  if (aggregate.steeringTexts.length === 0 && steering.length === 0) {
    deps.log(`session-meta: skipping evaluator for ${aggregate.sessionId} (no steering content)`)
    return { decision: 'skipped:no-steering', draftSlug: null }
  }
  const now = deps.now()
  if (deps.store.countEvaluationsSince(startOfUtcDay(now)) >= config.maxCallsPerDay) {
    deps.store.recordEvaluation({ ts: now, sessionId: aggregate.sessionId, inputTokens: 0, outputTokens: 0, decision: 'budget-refused', draftSlug: null })
    deps.log(`session-meta: evaluator daily cap reached, skipping ${aggregate.sessionId}`)
    return { decision: 'budget-refused', draftSlug: null }
  }
  if (deps.llm === undefined) {
    deps.log(`session-meta: skipping evaluator for ${aggregate.sessionId} (no llm service)`)
    return { decision: 'skipped:no-llm', draftSlug: null }
  }
  const projection = buildProjection(aggregate)
  const redactedSteering = steering.map(record => ({
    ...record,
    originalTask: redactString(record.originalTask, { cwd: aggregate.cwd }).text,
    correction: redactString(record.correction, { cwd: aggregate.cwd }).text,
  }))
  let result: { proposal: EvaluatorProposal; inputTokens: number; outputTokens: number }
  try {
    result = await runEvaluator(
      deps.llm,
      config,
      { projection, steering: redactedSteering, knownSignatures: listKnownSignatures(config.skillsDir) },
    )
  } catch (error) {
    deps.store.recordEvaluation({ ts: now, sessionId: aggregate.sessionId, inputTokens: 0, outputTokens: 0, decision: 'llm-error', draftSlug: null })
    deps.log(`session-meta: evaluator failed for ${aggregate.sessionId}: ${String(error)}`)
    return { decision: 'llm-error', draftSlug: null }
  }
  mkdirSync(config.skillsDir, { recursive: true })
  const draft = writeSkillDraft(config.skillsDir, result.proposal, {
    sessions: [aggregate.sessionId],
    mode: aggregate.origin ?? 'unknown',
  })
  deps.store.recordEvaluation({
    ts: now,
    sessionId: aggregate.sessionId,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    decision: 'draft-written',
    draftSlug: draft.slug,
  })
  if (fileRecord !== undefined) {
    const processedDir = processedSteeringDir(deps.home)
    mkdirSync(processedDir, { recursive: true })
    renameSync(steeringFilePath(deps.home, aggregate.sessionId), join(processedDir, `${aggregate.sessionId}.json`))
  }
  deps.log(`session-meta: gated draft ${draft.slug} written for ${aggregate.sessionId}`)
  return { decision: 'draft-written', draftSlug: draft.slug }
}
