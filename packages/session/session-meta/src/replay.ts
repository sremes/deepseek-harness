/**
 * M3 replay-driver seam (Plan-V1 §4.1 L2/L3 + Q15): dependency-free replay
 * outcome data, the structural runner seam an SDK-backed driver implements
 * later, a scripted fake for unit tests, the pure harm-veto comparison, and
 * the compact summary builder feeding `judgePair`.
 *
 * @module @deepseek-ai/dsh-session-meta/replay
 */

import type { ReplayOutcome, ReplayRunner } from './types.ts'

/**
 * Scripted fake runner serving queued outcomes in order for unit tests.
 */
export class FakeReplayRunner implements ReplayRunner {
  private readonly queue: ReplayOutcome[]

  /**
   * Capture the scripted outcome queue. The queue is copied so later
   * caller-side mutation cannot change the script.
   *
   * @param scripted - scripted outcomes served in order, one per `run()`.
   * @returns a fake runner over a private copy of the queue.
   */
  constructor(scripted: readonly ReplayOutcome[]) {
    this.queue = [...scripted]
  }

  /**
   * Shift one scripted outcome off the queue.
   *
   * @param input - task input, ignored by the fake.
   * @param options - optional run options, ignored by the fake (including any skill overlay).
   * @returns the next scripted outcome.
   */
  run(_input: string, _options?: { sessionId?: string; skillOverlay?: string }): Promise<ReplayOutcome> {
    const next = this.queue.shift()
    if (next === undefined) return Promise.reject(new Error('no scripted outcomes'))
    return Promise.resolve(next)
  }
}

/**
 * Pure harm veto over one candidate/baseline replay pair. Vetoes when the
 * baseline completed and the candidate did not, or when the candidate drew
 * more steering interventions than the baseline. A candidate that completes
 * where the baseline failed is an improvement, still needing the judge.
 * Step/token counts are deliberately ignored in V1 (plan: counted only on
 * tied outcomes, where fewer steps alone never passes).
 *
 * @param candidate - replay outcome with the candidate skill present.
 * @param baseline - replay outcome with the candidate skill absent.
 * @returns notWorse true unless a veto rule fired, plus one reason per failed rule.
 */
export function compareForHarm(
  candidate: ReplayOutcome,
  baseline: ReplayOutcome,
): { notWorse: boolean; reasons: string[] } {
  const reasons: string[] = []
  if (baseline.completed && !candidate.completed) {
    reasons.push('completed: baseline completed but candidate did not')
  }
  if (candidate.steeringCount > baseline.steeringCount) {
    reasons.push(
      `steering: candidate steeringCount ${candidate.steeringCount} exceeds baseline ${baseline.steeringCount}`,
    )
  }
  return { notWorse: reasons.length === 0, reasons }
}

/**
 * Build the compact judge input text for one replay outcome: a
 * completed/turnEnd line, a steering/tool-call counts line, then the
 * outcome summary body.
 *
 * @param outcome - replay outcome to summarize.
 * @returns compact multi-line text for `judgePair` input.
 */
export function buildReplaySummary(outcome: ReplayOutcome): string {
  return [
    `completed: ${outcome.completed ? 'true' : 'false'} (turnEnd: ${outcome.turnEnd ?? 'none'})`,
    `steering: ${outcome.steeringCount}, toolCalls: ${outcome.toolCalls}`,
    outcome.summary,
  ].join('\n')
}
