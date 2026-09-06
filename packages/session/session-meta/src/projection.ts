/**
 * Structured state projection Σ (Plan-V1 §3.3, SKILL.state note): fold one
 * finished aggregate into what-was-done / what-failed / what-the-human-said.
 * Pure and per-session — never a global schema. The evaluator sees this
 * projection plus the steering record, never raw history.
 *
 * M2.1: steps carry redacted tool arguments and failed-step result digests
 * so the evaluator can ground clauses in observed parameters; failed steps
 * mark recovery (a later same-tool success) with the retry's arguments, so
 * drafts capture the retry pattern, not the failure.
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
  const recovery = recoveryMap(aggregate.toolSteps)
  const kept = aggregate.toolSteps.slice(-maxSteps)
  const base = aggregate.toolSteps.length - kept.length
  const steps = kept.map((step, relative) => {
    const retry = recovery.get(base + relative)
    return {
      tool: step.tool,
      ok: step.ok,
      ...(step.error === undefined ? {} : { error: step.error }),
      ...(step.args === undefined ? {} : { args: step.args }),
      ...(step.resultDigest === undefined ? {} : { resultDigest: step.resultDigest }),
      ...(retry === undefined ? {} : { recovered: true as const, ...(retry === '' ? {} : { retryArgs: retry }) }),
    }
  })
  const truncatedSteps = Math.max(0, aggregate.toolSteps.length - steps.length) + aggregate.truncatedToolSteps
  return {
    sessionId: aggregate.sessionId,
    goal: aggregate.openingTask ?? '(unknown goal)',
    steps,
    truncatedSteps,
    errors: [...aggregate.toolErrors, ...aggregate.agentErrors],
    turnEnd: aggregate.turnEndReason ?? null,
    completed: isCompletedTurnEnd(aggregate.turnEndReason),
    skillsConsulted: [...aggregate.skillsConsulted],
    steeringTexts: [...aggregate.steeringTexts],
    counts: {
      events: aggregate.eventCount,
      toolCalls: aggregate.toolCalls,
      assistantMessages: aggregate.assistantMessages,
    },
  }
}

/**
 * Map failed step indexes to the args of the first later succeeding
 * same-tool step. A failed step with an entry recovered; without one it
 * stayed failed. Pure over the step list. Shared with the triage router
 * (`hasRecoveredErrors`), which proves recovery from the same map.
 */
export function recoveryMap(steps: ReadonlyArray<{ tool: string; ok: boolean; args?: string | undefined }>): Map<number, string> {
  const recovered = new Map<number, string>()
  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index]
    if (step === undefined || step.ok) continue
    for (let later = index + 1; later < steps.length; later += 1) {
      const retry = steps[later]
      if (retry !== undefined && retry.tool === step.tool && retry.ok) {
        recovered.set(index, retry.args ?? '')
        break
      }
    }
  }
  return recovered
}

function isCompletedTurnEnd(encodedReason: string | undefined): boolean {
  if (encodedReason === undefined) return false
  try {
    const reason = JSON.parse(encodedReason) as { kind?: unknown }
    return reason.kind === 'completed'
  } catch {
    return false
  }
}
