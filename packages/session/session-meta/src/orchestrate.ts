/**
 * Track A offline loop driver (Plan-V1 §3.3/M2): after a steered session
 * finalizes, gather both steering sources, enforce the daily evaluator
 * budget, run the Flash evaluator over the state projection, and persist
 * the proposal as a pipeline-gated skill draft. Every failure is contained
 * and ledgered — the session pipeline never throws into flush/dispose.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { EvaluatorLlm, EvaluatorRoute } from './evaluator.ts'
import { runEvaluator } from './evaluator.ts'
import { judgePair } from './judge.ts'
import { evaluateL0 } from './l0.ts'
import { evaluateL1 } from './l1.ts'
import { projectSession as buildProjection } from './projection.ts'
import { redactString } from './redact.ts'
import type { MetaRoute, ReplayOutcome, ReplayRunner } from './types.ts'
import { buildReplaySummary, compareForHarm } from './replay.ts'
import { parseSteeringFile, processedSteeringDir, steeringFilePath } from './steering.ts'
import { hasExplicitPersistRequest, hasRecoveredErrors } from './triage.ts'
import type { MetaStore } from './store.ts'
import type { EvaluatorProposal, SessionAggregate, SteeringRecord } from './types.ts'
import { renderDraft, slugify, writeSkillDraft, promoteDraftFile } from './writer.ts'

/** Whether a steering file exists for one session (flush-path pre-check). */
export function hasSteeringFile(home: string, sessionId: string): boolean {
  return existsSync(steeringFilePath(home, sessionId))
}

/** Resolved Track A loop settings (from plugin config). */
export interface EvaluationConfig extends EvaluatorRoute {
  readonly enabled: boolean
  readonly maxCallsPerDay: number
  readonly maxReplaysPerDay: number
  readonly minEvalToolCalls: number
  readonly earlySteeringMessages: number
  readonly maxPromotionsPerWeek: number
  readonly skillsDir: string
}

/** Runtime dependencies of one evaluation. */
export interface EvaluationDeps {
  readonly store: MetaStore
  readonly home: string
  readonly llm: EvaluatorLlm | undefined
  readonly replayRunner?: ReplayRunner | undefined
  readonly now: () => number
  readonly log: (message: string) => void
}

/** Rolling window for the weekly live-promotion blast cap (protocol constant). */
export const PROMOTION_WINDOW_MS = 7 * 24 * 3600 * 1000

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
 * Whether a finalized session should run the Track A evaluator. Pure:
 * unit-covered without a context. M2.2 effort gate: below `minEvalToolCalls`
 * with early-only steering and no recovery, the session is trivial (a typo
 * correction, not a learnable workflow) — except explicit persist requests,
 * which always evaluate. Owned here (not index.ts) so the post-hoc steering
 * driver reuses the exact live gate.
 */
export function shouldEvaluateTrackA(
  route: MetaRoute,
  enabled: boolean,
  aggregate: SessionAggregate,
  hasSteering: boolean,
  effort: Pick<EvaluationConfig, 'minEvalToolCalls' | 'earlySteeringMessages'>,
): boolean {
  if (route !== 'track_a' || !enabled) return false
  if (hasExplicitPersistRequest(aggregate.steeringTexts)) return true
  const recovered = hasRecoveredErrors(aggregate)
  if (!hasSteering && !recovered) return false
  if (recovered) return true
  const firstSteeringAt = aggregate.assistantMessagesAtFirstSteering ?? 0
  const trivial = aggregate.toolCalls < effort.minEvalToolCalls && firstSteeringAt <= effort.earlySteeringMessages
  return !trivial
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
  // M2.2: proven recovery is itself evaluable content (success mining) —
  // the evaluator drafts the retry pattern, not a correction.
  if (aggregate.steeringTexts.length === 0 && steering.length === 0 && !hasRecoveredErrors(aggregate)) {
    deps.log(`session-meta: skipping evaluator for ${aggregate.sessionId} (no steering content)`)
    return { decision: 'skipped:no-steering', draftSlug: null }
  }
  const now = deps.now()
  if (deps.store.countEvaluationsSince(startOfUtcDay(now)) >= config.maxCallsPerDay) {
    deps.store.recordEvaluation({ ts: now, sessionId: aggregate.sessionId, inputTokens: 0, outputTokens: 0, decision: 'budget-refused', draftSlug: null })
    deps.log(`session-meta: evaluator daily cap reached, skipping ${aggregate.sessionId}`)
    return { decision: 'budget-refused', draftSlug: null }
  }
  const llm = deps.llm
  if (llm === undefined) {
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
      llm,
      config,
      { sessionId: aggregate.sessionId, projection, steering: redactedSteering, knownSignatures: listKnownSignatures(config.skillsDir) },
    )
  } catch (error) {
    deps.store.recordEvaluation({ ts: now, sessionId: aggregate.sessionId, inputTokens: 0, outputTokens: 0, decision: 'llm-error', draftSlug: null })
    deps.log(`session-meta: evaluator failed for ${aggregate.sessionId}: ${String(error)}`)
    return { decision: 'llm-error', draftSlug: null }
  }
  mkdirSync(config.skillsDir, { recursive: true })
  const provenance = { sessions: [aggregate.sessionId], mode: aggregate.origin ?? 'unknown' } as const
  // M3 L0: cheapest layer first — render in memory and veto before any file
  // lands. The preview slug only feeds the `name:` field (writeSkillDraft
  // may add a numeric suffix); emptiness is unaffected by the suffix.
  const gate = evaluateL0(renderDraft(result.proposal, provenance, slugify(result.proposal.triggerSignature)))
  if (!gate.pass) {
    deps.store.recordEvaluation({ ts: now, sessionId: aggregate.sessionId, inputTokens: result.inputTokens, outputTokens: result.outputTokens, decision: 'l0-rejected', draftSlug: null })
    deps.log(`session-meta: draft failed L0 contract for ${aggregate.sessionId}: ${gate.violations.join('; ')}`)
    return { decision: 'l0-rejected', draftSlug: null }
  }
  // M3 L1: the Prescribed Pattern must hold a mechanically checkable clause
  // against the motivating session's tool calls. Same veto shape as L0.
  const selfTest = evaluateL1(result.proposal, projection.steps.map(step => step.tool))
  if (!selfTest.pass) {
    deps.store.recordEvaluation({ ts: now, sessionId: aggregate.sessionId, inputTokens: result.inputTokens, outputTokens: result.outputTokens, decision: 'l1-rejected', draftSlug: null })
    deps.log(`session-meta: draft failed L1 self-test for ${aggregate.sessionId}: ${selfTest.violations.join('; ')}`)
    return { decision: 'l1-rejected', draftSlug: null }
  }
  const draft = writeSkillDraft(config.skillsDir, result.proposal, {
    sessions: [aggregate.sessionId],
    mode: aggregate.origin ?? 'unknown',
  })
  // M3 L2: motivating-task replay (Plan-V1 §4.1) — run the opening task
  // with the draft mounted and without it, then veto on harm or on the
  // pairwise judge. Every skip preserves the pre-L2 behavior (promotion
  // proceeds): budget exhaustion skips instead of blocking because no
  // re-drive queue exists yet — a blocked draft would die unpromoted
  // forever. Judge spend is not ledgered this slice: judgePair returns no
  // token usage.
  const replayRunner = deps.replayRunner
  let taskInputUsedForL2: string | undefined
  if (replayRunner === undefined) {
    deps.log(`session-meta: l2 skipped (no replay runner) for ${aggregate.sessionId}`)
  } else {
    const taskInput = aggregate.openingTask ?? projection.goal
    if (taskInput.trim() === '') {
      deps.log(`session-meta: l2 skipped (no task input) for ${aggregate.sessionId}`)
    } else if (deps.store.countReplayRunsSince(startOfUtcDay(now)) + 2 > config.maxReplaysPerDay) {
      deps.log(`session-meta: l2 skipped (replay budget) for ${aggregate.sessionId}`)
    } else {
      taskInputUsedForL2 = taskInput
      let candidate: ReplayOutcome
      let baseline: ReplayOutcome
      try {
        candidate = await replayRunner.run(taskInput, { skillOverlay: draft.dir })
        baseline = await replayRunner.run(taskInput)
        deps.store.recordReplayRun(now)
        deps.store.recordReplayRun(now)
      } catch (error) {
        rmSync(draft.dir, { recursive: true, force: true })
        deps.store.recordEvaluation({ ts: now, sessionId: aggregate.sessionId, inputTokens: result.inputTokens, outputTokens: result.outputTokens, decision: 'l2-error', draftSlug: null })
        deps.log(`session-meta: replay failed for ${aggregate.sessionId}: ${String(error)}`)
        return { decision: 'l2-error', draftSlug: null }
      }
      const harm = compareForHarm(candidate, baseline)
      if (!harm.notWorse) {
        rmSync(draft.dir, { recursive: true, force: true })
        deps.store.recordEvaluation({ ts: now, sessionId: aggregate.sessionId, inputTokens: result.inputTokens, outputTokens: result.outputTokens, decision: 'l2-rejected', draftSlug: null })
        deps.log(`session-meta: draft failed L2 replay for ${aggregate.sessionId}: ${harm.reasons.join('; ')}`)
        return { decision: 'l2-rejected', draftSlug: null }
      }
      const verdict = await judgePair(llm, config, buildReplaySummary(candidate), buildReplaySummary(baseline))
      if (!verdict.pass) {
        rmSync(draft.dir, { recursive: true, force: true })
        deps.store.recordEvaluation({ ts: now, sessionId: aggregate.sessionId, inputTokens: result.inputTokens, outputTokens: result.outputTokens, decision: 'l2-rejected', draftSlug: null })
        deps.log(`session-meta: draft failed L2 judge for ${aggregate.sessionId}: ${verdict.grounds.join('; ')}`)
        return { decision: 'l2-rejected', draftSlug: null }
      }
    }
  }
  // M3 L3: regression-sample gate (Plan-V1 §4.1) — same A/B shape as L2
  // against up to 3 past same-trigger_signature sessions. Skips preserve
  // promotion (no re-drive queue exists yet); every veto removes the draft
  // dir, ledgers, and returns.
  const pastSessions = deps.store.listPromotionSessions(result.proposal.triggerSignature, 3, aggregate.sessionId)
  if (pastSessions.length === 0) {
    deps.log(`session-meta: l3 skipped (no history) for ${aggregate.sessionId}`)
  } else if (replayRunner === undefined) {
    deps.log(`session-meta: l3 skipped (no replay runner) for ${aggregate.sessionId}`)
  } else {
    const remainingReplays = config.maxReplaysPerDay - deps.store.countReplayRunsSince(startOfUtcDay(now))
    const affordablePairs = Math.floor(remainingReplays / 2)
    const targets = pastSessions.slice(0, Math.max(0, Math.min(pastSessions.length, affordablePairs)))
    if (targets.length === 0) {
      deps.log(`session-meta: l3 skipped (replay budget) for ${aggregate.sessionId}`)
    } else {
      for (const [pairIndex, target] of targets.entries()) {
        let pastCandidate: ReplayOutcome
        let pastBaseline: ReplayOutcome
        try {
          pastCandidate = await replayRunner.run(target.taskInput, { skillOverlay: draft.dir })
          pastBaseline = await replayRunner.run(target.taskInput)
          deps.store.recordReplayRun(now)
          deps.store.recordReplayRun(now)
        } catch (error) {
          rmSync(draft.dir, { recursive: true, force: true })
          deps.store.recordEvaluation({ ts: now, sessionId: aggregate.sessionId, inputTokens: result.inputTokens, outputTokens: result.outputTokens, decision: 'l3-error', draftSlug: null })
          deps.log(`session-meta: l3 replay failed for ${aggregate.sessionId} (pair ${pairIndex}): ${String(error)}`)
          return { decision: 'l3-error', draftSlug: null }
        }
        const pastHarm = compareForHarm(pastCandidate, pastBaseline)
        if (!pastHarm.notWorse) {
          rmSync(draft.dir, { recursive: true, force: true })
          deps.store.recordEvaluation({ ts: now, sessionId: aggregate.sessionId, inputTokens: result.inputTokens, outputTokens: result.outputTokens, decision: 'l3-rejected', draftSlug: null })
          deps.log(`session-meta: draft failed L3 replay for ${aggregate.sessionId} (pair ${pairIndex}): ${pastHarm.reasons.join('; ')}`)
          return { decision: 'l3-rejected', draftSlug: null }
        }
        const pastVerdict = await judgePair(llm, config, buildReplaySummary(pastCandidate), buildReplaySummary(pastBaseline))
        if (!pastVerdict.pass) {
          rmSync(draft.dir, { recursive: true, force: true })
          deps.store.recordEvaluation({ ts: now, sessionId: aggregate.sessionId, inputTokens: result.inputTokens, outputTokens: result.outputTokens, decision: 'l3-rejected', draftSlug: null })
          deps.log(`session-meta: draft failed L3 judge for ${aggregate.sessionId} (pair ${pairIndex}): ${pastVerdict.grounds.join('; ')}`)
          return { decision: 'l3-rejected', draftSlug: null }
        }
      }
    }
  }
  // M3 promotion (Plan-V1 §§3.4/4.1): passing the pipeline IS promotion —
  // the draft flips to live immediately. Probation is a confidence status
  // (0.40, one -0.15 regression archives), not a waiting room. L4-full
  // weekly (later slice) acts as demote-only. Live flips stay under the
  // weekly blast cap; over-cap passes hold at probation.
  deps.store.recordPromotion(result.proposal.triggerSignature, draft.slug)
  deps.store.recordPromotionSession(
    result.proposal.triggerSignature,
    aggregate.sessionId,
    taskInputUsedForL2 ?? aggregate.openingTask ?? projection.goal,
    now,
  )
  if (deps.store.countPromotionsSince(now - PROMOTION_WINDOW_MS) <= config.maxPromotionsPerWeek) {
    deps.store.recordLive(result.proposal.triggerSignature)
    promoteDraftFile(draft.dir)
    deps.store.recordEvaluation({
      ts: now,
      sessionId: aggregate.sessionId,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      decision: 'promoted',
      draftSlug: draft.slug,
    })
    if (fileRecord !== undefined) {
      const processedDir = processedSteeringDir(deps.home)
      mkdirSync(processedDir, { recursive: true })
      renameSync(steeringFilePath(deps.home, aggregate.sessionId), join(processedDir, `${aggregate.sessionId}.json`))
    }
    deps.log(`session-meta: promoted ${draft.slug} live for ${aggregate.sessionId}`)
    return { decision: 'promoted', draftSlug: draft.slug }
  }
  deps.log(`session-meta: promotion capped (blast radius), held at probation for ${aggregate.sessionId}`)
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
