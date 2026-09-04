/**
 * Structured state projection Σ (Plan-V1 §3.3, SKILL.state note): fold one
 * finished aggregate into what-was-done / what-failed / what-the-human-said.
 * Pure and per-session — never a global schema. The evaluator sees this
 * projection plus the steering record, never raw history.
 */

import type { SessionAggregate, SessionProjection } from './types.ts'

/** Default cap on projected steps; bounds the evaluator prompt. */
export const DEFAULT_PROJECTION_STEPS = 40

/**
 * Project one finished aggregate into Σ.
 *
 * @param aggregate - folded session aggregate at flush/dispose time.
 * @param maxSteps - steps retained (most recent); the rest count as truncated.
 */
export function projectSession(aggregate: SessionAggregate, maxSteps: number = DEFAULT_PROJECTION_STEPS): SessionProjection {
  const steps = aggregate.toolSteps.slice(-maxSteps).map(step => ({
    tool: step.tool,
    ok: step.ok,
    ...(step.error === undefined ? {} : { error: step.error }),
  }))
  const truncatedSteps = Math.max(0, aggregate.toolSteps.length - steps.length) + aggregate.truncatedToolSteps
  return {
    sessionId: aggregate.sessionId,
    goal: aggregate.openingTask ?? '(unknown goal)',
    steps,
    truncatedSteps,
    errors: [...aggregate.toolErrors, ...aggregate.agentErrors],
    turnEnd: aggregate.turnEndReason ?? null,
    steeringTexts: [...aggregate.steeringTexts],
    counts: {
      events: aggregate.eventCount,
      toolCalls: aggregate.toolCalls,
      assistantMessages: aggregate.assistantMessages,
    },
  }
}
