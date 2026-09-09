/**
 * Learning-loop input store for the DeepSeek Harness (dsh-meta M1): taps the
 * session firehose, redacts secrets, folds per-session aggregates, routes
 * them deterministically, and persists one row per session plus bounded
 * evidence into `$DSH_HOME/meta/meta.db`.
 *
 * Design notes:
 * - Subscribes to `session/event` + `session/flush` + `session/disposed` +
 *   `agent/error` directly (the telemetry coordinator's capture pattern) so
 *   the plugin works with any telemetry backend — or none. The canonical
 *   session log is never rewritten; redaction applies to the meta copy only.
 * - Synchronous handlers only aggregate and buffer. SQLite writes happen on
 *   `session/flush` and `session/disposed`, never on the event hot path.
 * - Zero writes to skills: M1 only observes. Promotion lives in M3.
 *
 * @module @deepseek-ai/dsh-session-meta
 */

import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-command-feedback'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import type { MetaRoute, ReplayRunner, SessionAggregate } from './types.ts'
import {
  errorNameOf, hasExplicitPersistRequest, hasRecoveredErrors, isSteeringMessage, newAggregate,
  observeAgentError, observeToolCall, observeToolResult, observeUserMessage, triage,
} from './triage.ts'
import { isCompletedTurnEnd } from './projection.ts'
import { applySessionSignals, sweepDecay } from './curator.ts'
import { TRACKB_RUN_TIMEOUT_MS, recordTrackB, startReproRun } from './trackb.ts'
import { redactString, redactValue } from './redact.ts'
import { MetaStore } from './store.ts'
import type { EvaluatorLlm } from './evaluator.ts'
import type { EvaluationConfig } from './orchestrate.ts'
import { evaluateTrackASession, hasSteeringFile } from './orchestrate.ts'

export type * from './types.ts'

/** Cordis plugin name. */
export const name = 'session-meta'

/**
 * No hard service injections: the plugin only taps the event bus, so it
 * boots in any profile with a session store and stays inert without one.
 */
export const inject: readonly string[] = []

/** Plugin config: storage location, evidence bounds, and the Track A loop. */
export interface Config {
  /** Explicit harness home; omitted follows `DSH_HOME`, then `~/.dsh`. */
  dshHome?: string
  /** Absolute database path override; defaults to `$DSH_HOME/meta/meta.db`. */
  dbPath?: string
  /** Evidence rows kept per session; oldest drop first. Defaults to 200. */
  maxEvidencePerSession?: number
  /** Skill-draft root override; defaults to `$DSH_HOME/skills`. */
  skillsDir?: string
  /** Track A evaluator (M2): disabled unless explicitly enabled with a route. */
  evaluator?: EvaluatorInputConfig
}

/** Raw evaluator knobs; validated fail-closed in `apply` (see `resolveEvaluation`). */
export interface EvaluatorInputConfig {
  enabled?: boolean
  provider?: string
  model?: string
  maxInputBytes?: number
  maxOutputTokens?: number
  timeoutMs?: number
  maxCallsPerDay?: number
  /** Replay runs allowed per UTC day across L2/L3 (each L2 attempt costs two). Defaults to 8. */
  maxReplaysPerDay?: number
  /** Sessions below this tool-call count need recovery or late steering to evaluate. */
  minEvalToolCalls?: number
  /** Steering at or before this many assistant messages counts as early (trivial). */
  earlySteeringMessages?: number
  /** Live promotions allowed per rolling 7-day window (blast cap). Defaults to 3. */
  maxPromotionsPerWeek?: number
}

export const Config: z<Config> = z.object({
  dshHome: z.string(),
  dbPath: z.string().default(''),
  maxEvidencePerSession: z.number().step(1).min(1).default(200),
  skillsDir: z.string().default(''),
  evaluator: z.any(),
})

interface Tracker {
  readonly aggregates: Map<string, SessionAggregate>
  readonly store: MetaStore
  readonly maxEvidence: number
  readonly home: string
  readonly evaluation: EvaluationConfig
  /** Sessions with a queued or settled Track A evaluation: flush fires per batch, evaluation runs once. */
  readonly evaluatedSessions: Set<string>
}

/**
 * Every Track A evaluation in flight, across all mounted contexts.
 * Keyed globally (not by context) because `apply` receives the plugin
 * fiber's forked context while callers hold the root — identity lookup
 * across that fork is unreliable, and production never settles.
 */
const pendingEvaluations = new Set<Promise<unknown>>()

/**
 * Replay runner handed to the L2/L3 gates. Session-meta never constructs
 * one (it must not import `sdk-client` or the replay adapter at runtime):
 * the host composition owns construction — typically
 * `new SdkReplayRunner(delegate)` from `@deepseek-ai/dsh-session-meta-replay`
 * around an SDK run function — and registers it here at boot. Absent, L2/L3
 * keep their skip-and-promote behavior.
 */
let activeReplayRunner: ReplayRunner | undefined = undefined

/**
 * Register (or clear) the replay runner the L2/L3 gates drive. Test and
 * composition seam; production hosts call it once at boot, tests reset it
 * after each case.
 *
 * @param runner - runner implementation, or undefined to restore skipping.
 */
export function setReplayRunner(runner: ReplayRunner | undefined): void {
  activeReplayRunner = runner
}

/**
 * Await every queued Track A evaluation. Test and maintenance seam;
 * production never calls it (flush stays non-blocking).
 */
export async function settleSessionMeta(): Promise<void> {
  while (pendingEvaluations.size > 0) {
    await Promise.all([...pendingEvaluations])
  }
}

/** Defaults for the Track A evaluator knobs. */
const EVALUATOR_DEFAULTS = {
  maxInputBytes: 12000,
  maxOutputTokens: 2000,
  timeoutMs: 120000,
  maxCallsPerDay: 1,
  maxReplaysPerDay: 8,
  minEvalToolCalls: 3,
  earlySteeringMessages: 1,
  maxPromotionsPerWeek: 3,
} as const

/**
 * Validate the raw evaluator knobs fail-closed: enabled requires an
 * explicit provider + model route; every limit falls back to its default.
 * Pure: unit-covered without a context.
 */
export function resolveEvaluation(config: Config, home: string): EvaluationConfig {
  const raw = config.evaluator ?? {}
  const enabled = raw.enabled ?? false
  const provider = raw.provider ?? ''
  const model = raw.model ?? ''
  if (enabled && (provider === '' || model === '')) {
    throw new Error('session-meta: evaluator.enabled requires explicit evaluator.provider and evaluator.model')
  }
  return {
    enabled,
    provider,
    model,
    maxInputBytes: raw.maxInputBytes ?? EVALUATOR_DEFAULTS.maxInputBytes,
    maxOutputTokens: raw.maxOutputTokens ?? EVALUATOR_DEFAULTS.maxOutputTokens,
    timeoutMs: raw.timeoutMs ?? EVALUATOR_DEFAULTS.timeoutMs,
    maxCallsPerDay: raw.maxCallsPerDay ?? EVALUATOR_DEFAULTS.maxCallsPerDay,
    maxReplaysPerDay: raw.maxReplaysPerDay ?? EVALUATOR_DEFAULTS.maxReplaysPerDay,
    minEvalToolCalls: raw.minEvalToolCalls ?? EVALUATOR_DEFAULTS.minEvalToolCalls,
    earlySteeringMessages: raw.earlySteeringMessages ?? EVALUATOR_DEFAULTS.earlySteeringMessages,
    maxPromotionsPerWeek: raw.maxPromotionsPerWeek ?? EVALUATOR_DEFAULTS.maxPromotionsPerWeek,
    skillsDir: config.skillsDir === undefined || config.skillsDir === '' ? join(home, 'skills') : config.skillsDir,
  }
}

/** Narrow `ctx.get('llm')` to the evaluator's structural surface. Test seam: unit-covered directly. */
export function optionalLlm(ctx: Context): EvaluatorLlm | undefined {
  const llm = ctx.get('llm') as EvaluatorLlm | null | undefined
  if (llm === null || llm === undefined || typeof llm.stream !== 'function') return undefined
  return llm
}

/**
 * Whether a finalized session should run the Track A evaluator. Pure:
 * unit-covered without a context. M2.2 effort gate: below `minEvalToolCalls`
 * with early-only steering and no recovery, the session is trivial (a typo
 * correction, not a learnable workflow) — except explicit persist requests,
 * which always evaluate.
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

/** Queue one Track A evaluation without blocking flush/dispose. */
function queueEvaluation(tracker: Tracker, ctx: Context, aggregate: SessionAggregate): void {
  if (tracker.evaluatedSessions.has(aggregate.sessionId)) return
  tracker.evaluatedSessions.add(aggregate.sessionId)
  const run = evaluateTrackASession(
    {
      store: tracker.store,
      home: tracker.home,
      llm: optionalLlm(ctx),
      replayRunner: activeReplayRunner,
      now: () => Date.now(),
      log: (message: string) => {
        ctx.logger.info(message)
      },
    },
    tracker.evaluation,
    aggregate,
  ).catch((error: unknown) => {
    ctx.logger.warn(`session-meta: evaluation containment failed: ${String(error)}`)
  })
  pendingEvaluations.add(run)
  void run.finally(() => {
    pendingEvaluations.delete(run)
  })
}

function ensureAggregate(tracker: Tracker, session: Session): SessionAggregate {
  const id = String(session.id)
  const seen = tracker.aggregates.get(id)
  if (seen !== undefined) return seen
  const created = newAggregate(id, session.header.createdAt, {
    cwd: session.header.cwd ?? undefined,
    parentSession: session.header.parentSession === undefined ? undefined : String(session.header.parentSession),
    origin: session.header.origin ?? undefined,
  })
  tracker.aggregates.set(id, created)
  return created
}

function retainEvidence(
  tracker: Tracker,
  aggregate: SessionAggregate,
  seq: number,
  type: string,
  severity: 'info' | 'warn' | 'error',
  data: unknown,
): void {
  if (aggregate.evidence.length >= tracker.maxEvidence) {
    aggregate.droppedEvidence += 1
    return
  }
  const redacted = redactValue(data, { cwd: aggregate.cwd })
  aggregate.evidence.push({ seq, type, severity, body: JSON.stringify(redacted.value) })
}

function observeEvent(tracker: Tracker, session: Session, event: SessionEvent): void {
  const aggregate = ensureAggregate(tracker, session)
  aggregate.eventCount += 1
  switch (event.type) {
    case 'assistant/message': {
      aggregate.assistantMessages += 1
      break
    }
    case 'tool/call': {
      aggregate.toolCalls += 1
      observeToolCall(aggregate, event.data)
      break
    }
    case 'tool/result': {
      if (event.data.error !== undefined) {
        observeToolResult(aggregate, event.data)
        retainEvidence(tracker, aggregate, Number(event.seq), event.type, 'error', event.data)
      }
      break
    }
    case 'user/message': {
      observeUserMessage(aggregate, event.data, aggregate.assistantMessages > 0)
      if (isSteeringMessage(event.data, aggregate.assistantMessages > 0)) {
        retainEvidence(tracker, aggregate, Number(event.seq), event.type, 'info', event.data)
      }
      break
    }
    case 'feedback/record': {
      aggregate.feedbackEvents += 1
      break
    }
    case 'turn/end': {
      aggregate.turnEndReason = JSON.stringify(event.data.reason)
      break
    }
    default: {
      break
    }
  }
}

function finalizeSession(tracker: Tracker, session: Session, ctx: Context): void {
  const aggregate = ensureAggregate(tracker, session)
  const verdict = triage(aggregate)
  const endedAt = Date.now()
  tracker.store.writeSession({
    id: aggregate.sessionId,
    cwd: aggregate.cwd ?? null,
    parentSession: aggregate.parentSession ?? null,
    origin: aggregate.origin ?? null,
    startedAt: aggregate.startedAt,
    endedAt,
    events: aggregate.eventCount,
    toolCalls: aggregate.toolCalls,
    toolErrors: aggregate.toolErrors,
    agentErrors: aggregate.agentErrors,
    steeringEvents: aggregate.steeringEvents,
    feedbackEvents: aggregate.feedbackEvents,
    assistantMessages: aggregate.assistantMessages,
    turnEndReason: aggregate.turnEndReason ?? null,
    route: verdict.route,
    reasons: verdict.reasons,
    droppedEvidence: aggregate.droppedEvidence,
    evidence: aggregate.evidence,
  })
  const scrubbed = redactString(aggregate.sessionId, {})
  ctx.logger.info(`session-meta: session ${scrubbed.text} -> ${verdict.route} (${verdict.reasons.join(', ')})`)
  try {
    applySessionSignals(
      tracker.store,
      tracker.evaluation.skillsDir,
      (message: string) => {
        ctx.logger.info(message)
      },
      {
        skillsConsulted: aggregate.skillsConsulted,
        steeringEvents: aggregate.steeringEvents,
        completed: isCompletedTurnEnd(aggregate.turnEndReason),
      },
    )
    sweepDecay(tracker.store, tracker.evaluation.skillsDir, (message: string) => {
      ctx.logger.info(message)
    }, endedAt)
    if (verdict.route === 'track_b') {
      const emitted = recordTrackB(aggregate, join(tracker.home, '.dsh', 'reproductions'), endedAt, (message: string) => {
        ctx.logger.info(message)
      })
      // M4 spec runner: only the emit path has a spec to execute (breakages
      // have no spec). Fire-and-forget on the shared pending set so
      // settleSessionMeta awaits it; production flush stays non-blocking.
      // DELIBERATE NON-GOAL: no curator hook reads repro outcomes — a passing
      // repro means the bug still reproduces and attaches to a session, not a
      // skill, so no skill earns +0.10 from it; the ledger is the audit trail
      // and invalidation stays human/reviewer-side until M5.
      const run = startReproRun({
        emitted,
        startDir: dirname(fileURLToPath(new URL(import.meta.url))),
        timeoutMs: TRACKB_RUN_TIMEOUT_MS,
        store: tracker.store,
        now: endedAt,
        log: (message: string) => {
          ctx.logger.info(message)
        },
      })
      pendingEvaluations.add(run)
      void run.finally(() => {
        pendingEvaluations.delete(run)
      })
    }
    /* v8 ignore start -- curator calls are contained; a store failure needs a broken registry. */
  } catch (error) {
    ctx.logger.warn(`session-meta: lifecycle signals failed: ${String(error)}`)
  }
  /* v8 ignore stop */
  if (
    shouldEvaluateTrackA(
      verdict.route,
      tracker.evaluation.enabled,
      aggregate,
      aggregate.steeringTexts.length > 0 || hasSteeringFile(tracker.home, aggregate.sessionId),
      tracker.evaluation,
    )
  ) {
    queueEvaluation(tracker, ctx, aggregate)
  }
}

/**
 * Mount the firehose tap, the flush/dispose finalizers, and the agent-error
 * relay. All registrations bind to this plugin's fiber: unloading drops the
 * tap and closes the store.
 *
 * @param ctx - plugin context owning the listeners and the store lifetime.
 * @param config - storage location, evidence bounds, and the Track A loop.
 */
export function apply(ctx: Context, config: Config): void {
  const home = resolveDshHome(config.dshHome)
  const dbPath = config.dbPath === undefined || config.dbPath === '' ? join(home, 'meta', 'meta.db') : config.dbPath
  const store = new MetaStore({ dbPath })
  const tracker: Tracker = {
    aggregates: new Map(),
    store,
    /* v8 ignore next -- schemastery fills the 200 default during validation, so the fallback is unreachable post-validation. */
    maxEvidence: config.maxEvidencePerSession ?? 200,
    home,
    evaluation: resolveEvaluation(config, home),
    evaluatedSessions: new Set(),
  }
  ctx.effect(() => () => {
    store.close()
  })
  // Drain handle for one-shot hosts: the headless runner awaits it after
  // flush so fire-and-forget evaluations and repro runs settle instead of
  // dying with the process. Absent hosts ignore it.
  ctx.provide('sessionMeta', { settle: () => settleSessionMeta() })
  ctx.on('session/event', (session, event) => {
    observeEvent(tracker, session, event)
  })
  ctx.on('session/flush', (session) => {
    finalizeSession(tracker, session, ctx)
  })
  ctx.on('session/disposed', (session) => {
    finalizeSession(tracker, session, ctx)
    tracker.aggregates.delete(String(session.id))
  })
  ctx.on('agent/error', ({ agent, error }) => {
    const aggregate = ensureAggregate(tracker, agent.session)
    aggregate.eventCount += 1
    observeAgentError(aggregate, errorNameOf(error))
    retainEvidence(tracker, aggregate, aggregate.eventCount, 'agent/error', 'error', { error: errorNameOf(error) })
  })
}
