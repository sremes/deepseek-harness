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

import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-command-feedback'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import type { SessionAggregate } from './types.ts'
import { errorNameOf, isSteeringMessage, newAggregate, observeAgentError, observeToolError, triage } from './triage.ts'
import { redactString, redactValue } from './redact.ts'
import { MetaStore } from './store.ts'

export type * from './types.ts'

/** Cordis plugin name. */
export const name = 'session-meta'

/**
 * No hard service injections: the plugin only taps the event bus, so it
 * boots in any profile with a session store and stays inert without one.
 */
export const inject: readonly string[] = []

/** Plugin config: storage location and evidence bounds. */
export interface Config {
  /** Explicit harness home; omitted follows `DSH_HOME`, then `~/.dsh`. */
  dshHome?: string
  /** Absolute database path override; defaults to `$DSH_HOME/meta/meta.db`. */
  dbPath?: string
  /** Evidence rows kept per session; oldest drop first. Defaults to 200. */
  maxEvidencePerSession?: number
}

export const Config: z<Config> = z.object({
  dshHome: z.string(),
  dbPath: z.string().default(''),
  maxEvidencePerSession: z.number().step(1).min(1).default(200),
})

interface Tracker {
  readonly aggregates: Map<string, SessionAggregate>
  readonly store: MetaStore
  readonly maxEvidence: number
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
      break
    }
    case 'tool/result': {
      if (event.data.error !== undefined) {
        const name = errorNameOf(event.data.error)
        observeToolError(aggregate, name)
        retainEvidence(tracker, aggregate, Number(event.seq), event.type, 'error', event.data)
      }
      break
    }
    case 'user/message': {
      if (isSteeringMessage(event.data, aggregate.assistantMessages > 0)) {
        aggregate.steeringEvents += 1
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
}

/**
 * Mount the firehose tap, the flush/dispose finalizers, and the agent-error
 * relay. All registrations bind to this plugin's fiber: unloading drops the
 * tap and closes the store.
 *
 * @param ctx - plugin context owning the listeners and the store lifetime.
 * @param config - storage location and evidence bounds.
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
  }
  ctx.effect(() => () => {
    store.close()
  })
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
