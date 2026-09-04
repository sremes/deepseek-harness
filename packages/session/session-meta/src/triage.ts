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
import { redactString } from './redact.ts'

/** Tool steps retained per aggregate; beyond this the projection counts truncation. */
export const MAX_TOOL_STEPS = 50

/** Steering texts retained per aggregate; beyond this the oldest drops. */
export const MAX_STEERING_TEXTS = 10

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
    steeringTexts: [],
    openingTask: undefined,
    toolSteps: [],
    truncatedToolSteps: 0,
    pendingToolCalls: new Map(),
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

/** Cap on retained human-message text per message (bounds the projection). */
export const MAX_RETAINED_MESSAGE_CHARS = 2000

/**
 * Best-effort plain text of a message payload: joins `text` content blocks,
 * falls back to a capped JSON dump. Never throws on odd shapes.
 */
export function messageText(data: unknown): string {
  if (typeof data === 'object' && data !== null) {
    const content = (data as { content?: unknown }).content
    if (Array.isArray(content)) {
      const text = content
        .filter((block): block is { type: string; text: string } =>
          typeof block === 'object' && block !== null &&
          (block as { type?: unknown }).type === 'text' &&
          typeof (block as { text?: unknown }).text === 'string')
        .map(block => block.text)
        .join('\n')
      if (text !== '') return text.slice(0, MAX_RETAINED_MESSAGE_CHARS)
    }
  }
  try {
    const dumped: unknown = JSON.stringify(data)
    return typeof dumped === 'string' ? dumped.slice(0, MAX_RETAINED_MESSAGE_CHARS) : ''
  } catch {
    return ''
  }
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

/**
 * Fold one `tool/call` payload: records the step outcome slot (optimistic
 * ok) and maps its call id for the later result. Pure over the aggregate.
 */
export function observeToolCall(aggregate: SessionAggregate, data: unknown): void {
  const fields = (typeof data === 'object' && data !== null ? data : {}) as {
    name?: unknown
    callId?: unknown
  }
  const tool = typeof fields.name === 'string' && fields.name !== '' ? fields.name : 'unknown-tool'
  if (aggregate.toolSteps.length >= MAX_TOOL_STEPS) {
    aggregate.truncatedToolSteps += 1
    return
  }
  aggregate.toolSteps.push({ tool, ok: true })
  if (typeof fields.callId === 'string' && fields.callId !== '') {
    aggregate.pendingToolCalls.set(fields.callId, aggregate.toolSteps.length - 1)
  }
}

/**
 * Fold one errored `tool/result` payload: records the error name and marks
 * the matching step failed. The call id rides top-level in synthetic
 * payloads and inside `message` in live session events — both are honored.
 * Results without a recorded call id still fold the error (attribution
 * degrades, counting does not).
 */
export function observeToolResult(aggregate: SessionAggregate, data: unknown): void {
  const fields = (typeof data === 'object' && data !== null ? data : {}) as {
    callId?: unknown
    error?: unknown
    message?: unknown
  }
  const name = errorNameOf(fields.error)
  observeToolError(aggregate, name)
  const nested = (typeof fields.message === 'object' && fields.message !== null ? fields.message : {}) as {
    callId?: unknown
  }
  const rawCallId = typeof fields.callId === 'string' ? fields.callId : nested.callId
  const callId = typeof rawCallId === 'string' ? rawCallId : undefined
  const index = callId === undefined ? undefined : aggregate.pendingToolCalls.get(callId)
  if (index === undefined) return
  const step = aggregate.toolSteps[index]
  if (step !== undefined) {
    step.ok = false
    step.error = name
  }
}

/**
 * Fold one `user/message` payload: captures the opening task once, counts
 * human steering, and retains redacted steering texts (bounded).
 */
export function observeUserMessage(aggregate: SessionAggregate, data: unknown, seenAssistant: boolean): void {
  if (isHumanMessage(data) && aggregate.openingTask === undefined) {
    aggregate.openingTask = redactString(messageText(data), { cwd: aggregate.cwd }).text
  }
  if (!isSteeringMessage(data, seenAssistant)) return
  aggregate.steeringEvents += 1
  aggregate.steeringTexts.push(redactString(messageText(data), { cwd: aggregate.cwd }).text)
  if (aggregate.steeringTexts.length > MAX_STEERING_TEXTS) {
    aggregate.steeringTexts.shift()
  }
}

/** Whether the payload carries a human (`user`-kind) source marker. */
function isHumanMessage(data: unknown): boolean {
  if (typeof data !== 'object' || data === null) return false
  const source = (data as { source?: unknown }).source
  if (typeof source !== 'object' || source === null) return false
  return (source as { kind?: unknown }).kind === 'user'
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
