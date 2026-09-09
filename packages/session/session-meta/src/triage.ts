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
import { isCompletedTurnEnd, recoveryMap } from './projection.ts'
import { redactString } from './redact.ts'

/** Tool steps retained per aggregate; beyond this the projection counts truncation. */
export const MAX_TOOL_STEPS = 50

/** Steering texts retained per aggregate; beyond this the oldest drops. */
export const MAX_STEERING_TEXTS = 10

/** Tool-call argument chars retained per step (M2.1 grounding bound). */
export const MAX_TOOL_ARG_CHARS = 500

/** Result-text chars retained on failed steps (M2.1 grounding bound). */
export const MAX_RESULT_DIGEST_CHARS = 300

/** Skill names retained per aggregate; beyond this later consults drop. */
export const MAX_SKILLS_CONSULTED = 20

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
    skillsConsulted: [],
    assistantMessagesAtFirstSteering: undefined,
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

/**
 * Environment-blocked error names: setup/sandbox failures, never product
 * faults. `SandboxUnavailableError` is thrown by the shell sandbox backends
 * when no runner backend exists; `MISSING_CREDENTIAL` is raised by the LLM
 * providers when no key resolves. Tag-only (Plan-V1 §5.2): sessions whose
 * every failure signal is env-class keep their route and gain the
 * `env-blocked` reason, so the Track B corpus stays countable without
 * rerouting anything.
 */
const ENV_BLOCKED_ERROR_NAMES: ReadonlySet<string> = new Set([
  'SandboxUnavailableError',
  'MISSING_CREDENTIAL',
])

function pushUnique(target: string[], name: string): void {
  if (!target.includes(name)) target.push(name)
}

/** Fold one tool-error name into the aggregate. */
export function observeToolError(aggregate: SessionAggregate, name: string): void {
  pushUnique(aggregate.toolErrors, name)
}

/** Fold one `tool/call` payload: records the step outcome slot (optimistic
 * ok) and maps its call id for the later result. Pure over the aggregate.
 * M2.1: retains redacted truncated arguments and folds `skill`-tool
 * consults for patch-in-place targeting.
 */
export function observeToolCall(aggregate: SessionAggregate, data: unknown): void {
  const fields = (typeof data === 'object' && data !== null ? data : {}) as {
    name?: unknown
    callId?: unknown
    arguments?: unknown
  }
  const tool = typeof fields.name === 'string' && fields.name !== '' ? fields.name : 'unknown-tool'
  if (aggregate.toolSteps.length >= MAX_TOOL_STEPS) {
    aggregate.truncatedToolSteps += 1
    return
  }
  const step: { tool: string; ok: boolean; args?: string } = { tool, ok: true }
  if (typeof fields.arguments === 'string' && fields.arguments !== '') {
    const redacted = redactString(fields.arguments, { cwd: aggregate.cwd }).text
    step.args = redacted.slice(0, MAX_TOOL_ARG_CHARS)
  }
  aggregate.toolSteps.push(step)
  if (tool === 'skill') observeSkillConsult(aggregate, fields.arguments)
  if (typeof fields.callId === 'string' && fields.callId !== '') {
    aggregate.pendingToolCalls.set(fields.callId, aggregate.toolSteps.length - 1)
  }
}

/**
 * Fold one `skill`-tool invocation's target name. Best-effort JSON parse;
 * unparseable arguments still counted the call, just not the consult.
 */
function observeSkillConsult(aggregate: SessionAggregate, rawArguments: unknown): void {
  if (typeof rawArguments !== 'string' || aggregate.skillsConsulted.length >= MAX_SKILLS_CONSULTED) return
  try {
    const parsed = JSON.parse(rawArguments) as { name?: unknown }
    if (typeof parsed.name === 'string' && parsed.name !== '' && !aggregate.skillsConsulted.includes(parsed.name)) {
      aggregate.skillsConsulted.push(parsed.name)
    }
  } catch {
    return
  }
}

/**
 * Best-effort plain text of a `tool/result` message payload: joins `text`
 * content blocks under `message`, falls back to a capped JSON dump.
 */
export function resultText(data: unknown): string {
  if (typeof data === 'object' && data !== null) {
    const message = (data as { message?: unknown }).message
    if (typeof message === 'object' && message !== null) {
      const content = (message as { content?: unknown }).content
      if (Array.isArray(content)) {
        const text = content
          .filter((block): block is { type: string; text: string } =>
            typeof block === 'object' && block !== null &&
            (block as { type?: unknown }).type === 'text' &&
            typeof (block as { text?: unknown }).text === 'string')
          .map(block => block.text)
          .join('\n')
        if (text !== '') return text.slice(0, MAX_RESULT_DIGEST_CHARS)
      }
    }
  }
  return ''
}

/**
 * Whether any steering text is an explicit persist request ("remember
 * this", "from now on", ...). M2.2: bypasses the effort gate — keyword
 * detection, no LLM.
 */
export function hasExplicitPersistRequest(texts: readonly string[]): boolean {
  return texts.some(text =>
    /\bremember this\b|\bfrom now on\b|\bas a rule\b|don't forget|do not forget/i.test(text))
}

/**
 * Fold one errored `tool/result` payload: records the error name and marks
 * the matching step failed. The call id rides top-level in synthetic
 * payloads; in live session events it nests inside `message` — as
 * `message.callId`, `message.source.callId`, or a content block's
 * `toolCallId` (the `dsh-tool-result` block shape). All are honored.
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
  const callId = resultCallId(fields.callId, fields.message)
  const index = callId === undefined ? undefined : aggregate.pendingToolCalls.get(callId)
  if (index === undefined) return
  const step = aggregate.toolSteps[index]
  if (step !== undefined) {
    step.ok = false
    step.error = name
    const digest = resultText(data)
    if (digest !== '') step.resultDigest = digest
  }
}

/**
 * Best-effort call id for a `tool/result` payload: top-level `callId`,
 * then `message.callId`, `message.source.callId`, then the first string
 * `toolCallId` in `message.content` blocks. Never throws on odd shapes.
 */
export function resultCallId(topCallId: unknown, message: unknown): string | undefined {
  if (typeof topCallId === 'string' && topCallId !== '') return topCallId
  if (typeof message !== 'object' || message === null) return undefined
  const msg = message as { callId?: unknown; source?: unknown; content?: unknown }
  if (typeof msg.callId === 'string' && msg.callId !== '') return msg.callId
  if (typeof msg.source === 'object' && msg.source !== null) {
    const sourceCallId = (msg.source as { callId?: unknown }).callId
    if (typeof sourceCallId === 'string' && sourceCallId !== '') return sourceCallId
  }
  if (Array.isArray(msg.content)) {
    for (const block of msg.content) {
      if (typeof block === 'object' && block !== null) {
        const toolCallId = (block as { toolCallId?: unknown }).toolCallId
        if (typeof toolCallId === 'string' && toolCallId !== '') return toolCallId
      }
    }
  }
  return undefined
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
  if (aggregate.assistantMessagesAtFirstSteering === undefined) {
    aggregate.assistantMessagesAtFirstSteering = aggregate.assistantMessages
  }
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

/**
 * Whether the session shows proven recovery: at least one failed step, and
 * every failed step has a later succeeding same-tool step. Recovery proven
 * only by steps — error names without step evidence do not count.
 */
export function hasRecoveredErrors(aggregate: SessionAggregate): boolean {
  const failed = aggregate.toolSteps.filter(step => !step.ok)
  if (failed.length === 0) return false
  const recovered = recoveryMap(aggregate.toolSteps)
  return aggregate.toolSteps.every((step, index) => step.ok || recovered.has(index))
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
  // Tag-only env-block: every tool error is env-class and no structural or
  // agent signal exists. The route is untouched — the tag only makes the
  // env share countable for the future graceful-degradation corpus.
  const envOnly = aggregate.toolErrors.length > 0 &&
    aggregate.toolErrors.every(name => ENV_BLOCKED_ERROR_NAMES.has(name)) &&
    structural.length === 0 &&
    aggregate.agentErrors.length === 0
  if (envOnly) reasons.push('env-blocked')
  if (structural.length > 0 || aggregate.agentErrors.length > 0 || turnFailed) {
    route = 'track_b'
  } else if (aggregate.toolErrors.length > 0) {
    // M2.2: recovered errors on a completed turn are procedural memory
    // (how the session recovered), not structural telemetry. turnFailed is
    // false on this branch, so a present turn-end reason means completed.
    if (aggregate.turnEndReason !== undefined && hasRecoveredErrors(aggregate)) {
      route = 'track_a'
      reasons.push('success-recovered')
      if (aggregate.steeringEvents > 0) reasons.push(`steering:${aggregate.steeringEvents}`)
    } else {
      route = 'track_b'
    }
  } else if (aggregate.steeringEvents > 0) {
    route = 'track_a'
    reasons.push(`steering:${aggregate.steeringEvents}`)
  }
  if (route === 'no_op') reasons.push('no-signal')
  return { route, reasons }
}
