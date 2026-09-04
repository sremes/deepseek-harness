/**
 * Deterministic triage router for the session-meta store (Plan-V1 §3.2): no
 * LLM, no heuristics beyond explicit signals. Pure functions over
 * {@link SessionAggregate} so every branch is unit-testable without cordis.
 *
 * Routing:
 * - `SyntaxError / JSONParseError / ZodError / tool-error / agent-error /
 *   non-completed turn end` → **track_b** (structural telemetry).
 * - Human steering (`user`-kind `user/message` after the first assistant
 *   message, or an orchestrator correction record) → **track_a**
 *   (procedural memory).
 * - Anything else → **no_op**.
 * - Inbox events whose message source is not human (`agent-message` relays,
 *   tool frames, plugin notices) are never steering (lineage filter).
 *
 * @module @deepseek-ai/dsh-session-meta/triage
 */

import type { MetaRoute, MetaTriage, SessionAggregate } from './types.ts'

/** Fresh aggregate for a session; evidence starts empty. */
export function newAggregate(
  sessionId: string,
  startedAt: number,
  header?: { cwd?: string | undefined; parentSession?: string | undefined; origin?: string | undefined },
): SessionAggregate {
  return {
    sessionId,
    cwd: header?.cwd,
    parentSession: header?.parentSession,
    origin: header?.origin,
    startedAt,
    eventCount: 0,
    assistantMessages: 0,
    toolCalls: 0,
    toolErrors: [],
    agentErrors: [],
    steeringEvents: 0,
    feedbackEvents: 0,
    turnEndReason: undefined,
    evidence: [],
    droppedEvidence: 0,
  }
}

/**
 * Whether a `user/message` data payload is human steering. `seenAssistant`
 * must be true — the opening prompt of a session is a task, not a
 * correction. Anything without a human (`user`-kind) source is chatter.
 */
export function isSteeringMessage(data: unknown, seenAssistant: boolean): boolean {
  if (!seenAssistant) return false
  if (typeof data !== 'object' || data === null) return false
  const source = (data as { source?: unknown }).source
  if (typeof source !== 'object' || source === null) return false
  return (source as { kind?: unknown }).kind === 'user'
}

/** Best-effort error name for an `agent/error` payload or `tool/result.error`. */
export function errorNameOf(error: unknown): string {
  if (typeof error === 'object' && error !== null) {
    const named = (error as { name?: unknown }).name
    if (typeof named === 'string' && named !== '') return named
    const code = (error as { code?: unknown }).code
    if (typeof code === 'string' && code !== '') return code
  }
  if (typeof error === 'string' && error !== '') return error
  return 'unknown-error'
}

/** Track-B class exception names (Plan-V1 §3.2 deterministic set). */
const TRACK_B_ERROR_NAMES: ReadonlySet<string> = new Set([
  'SyntaxError',
  'JSONParseError',
  'ZodError',
  'ERR_REGEX_TIMEOUT',
  'ERR_TOOL_SCHEMA_VIOLATION',
])

function pushUnique(target: string[], name: string): void {
  if (!target.includes(name)) target.push(name)
}

/** Fold one tool-error name into the aggregate. */
export function observeToolError(aggregate: SessionAggregate, name: string): void {
  pushUnique(aggregate.toolErrors, name)
}

/** Fold one agent-error name into the aggregate. */
export function observeAgentError(aggregate: SessionAggregate, name: string): void {
  pushUnique(aggregate.agentErrors, name)
}

/** Route one finished aggregate. Every branch is total — reasons always explain. */
export function triage(aggregate: SessionAggregate): MetaTriage {
  const reasons: string[] = []
  let route: MetaRoute = 'no_op'
  const structural = aggregate.toolErrors.filter(name => TRACK_B_ERROR_NAMES.has(name))
  for (const name of structural) reasons.push(`structural-error:${name}`)
  for (const name of aggregate.toolErrors) {
    if (!TRACK_B_ERROR_NAMES.has(name)) reasons.push(`tool-error:${name}`)
  }
  for (const name of aggregate.agentErrors) reasons.push(`agent-error:${name}`)
  const turnFailed = aggregate.turnEndReason !== undefined && !isCompletedTurnEnd(aggregate.turnEndReason)
  if (turnFailed) reasons.push(`turn-end:${aggregate.turnEndReason}`)
  if (structural.length > 0 || aggregate.agentErrors.length > 0 || turnFailed) {
    route = 'track_b'
  } else if (aggregate.toolErrors.length > 0) {
    route = 'track_b'
  } else if (aggregate.steeringEvents > 0) {
    route = 'track_a'
    reasons.push(`steering:${aggregate.steeringEvents}`)
  }
  if (route === 'no_op') reasons.push('no-signal')
  return { route, reasons }
}

function isCompletedTurnEnd(encodedReason: string): boolean {
  try {
    const reason = JSON.parse(encodedReason) as { kind?: unknown }
    return reason.kind === 'completed'
  } catch {
    return false
  }
}
