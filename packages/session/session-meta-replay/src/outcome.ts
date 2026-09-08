/**
 * Pure `RunResult`-to-`ReplayOutcome` mapping for the M3 replay driver
 * (Plan-V1 §4.1 L2/L3): fold one owned activity interval into the outcome
 * data the harm veto and the pairwise judge read. No I/O, no imports beyond
 * the `SessionEvent` type.
 *
 * @module @deepseek-ai/dsh-session-meta-replay/outcome
 */

import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { ReplayOutcome } from './types.ts'

/**
 * Chars retained from the final response in an outcome summary. The judge
 * input stays bounded while keeping the replay's concluding text; matches
 * the per-message retention scale the triage projection uses.
 */
export const REPLAY_SUMMARY_MAX_CHARS = 2000

/**
 * Whether a `user/message` event is human steering: a human (`user`-kind)
 * source observed after the first assistant message. Mirrors
 * `isSteeringMessage` in `packages/session/session-meta/src/triage.ts` with
 * the same caller rule `observeUserMessage` receives
 * (`aggregate.assistantMessages > 0` in `session-meta/src/index.ts`): the
 * opening prompt is a task, never a correction, and non-human sources
 * (relays, tool frames, plugin notices, catalogs) are never steering.
 *
 * @param event - one `user/message` session event.
 * @param seenAssistant - whether an `assistant/message` preceded it.
 * @returns true for a counted steering intervention.
 */
function isSteeringUserMessage(event: Extract<SessionEvent, { type: 'user/message' }>, seenAssistant: boolean): boolean {
  return seenAssistant && event.data.source.kind === 'user'
}

/**
 * Map one owned run interval onto the replay outcome.
 *
 * - `completed` reads the last `turn/end` reason: true only for the
 *   `completed` kind. The literal duplicates the one `isCompletedTurnEnd`
 *   checks in `packages/session/session-meta/src/projection.ts` (M2.2 single
 *   completion definition); a run with no `turn/end` never completed.
 * - `turnEnd` is that reason's kind verbatim, or null without one.
 * - `steeringCount` counts source-marked human `user/message` events after
 *   the first `assistant/message` (the triage steering rule above).
 * - `toolCalls` counts `tool/call` events.
 * - `summary` is the final response truncated to
 *   {@link REPLAY_SUMMARY_MAX_CHARS}.
 *
 * @param events - the run's `session.event` payloads in wire order.
 * @param finalResponse - concatenated text of the run's last assistant message.
 * @returns the replay outcome for the harm veto and judge input.
 */
export function mapRunResultToOutcome(events: SessionEvent[], finalResponse: string): ReplayOutcome {
  let turnEnd: string | null = null
  let steeringCount = 0
  let toolCalls = 0
  let seenAssistant = false
  for (const event of events) {
    switch (event.type) {
      case 'assistant/message': {
        seenAssistant = true
        break
      }
      case 'user/message': {
        if (isSteeringUserMessage(event, seenAssistant)) steeringCount += 1
        break
      }
      case 'tool/call': {
        toolCalls += 1
        break
      }
      case 'turn/end': {
        turnEnd = event.data.reason.kind
        break
      }
      default: {
        // Merge-extensible log: boundary markers, chunks, and plugin events never shape the outcome.
        break
      }
    }
  }
  // Single completion definition (M2.2): kept as a literal beside the
  // `projection.isCompletedTurnEnd` predicate it duplicates, so the two stay
  // greppable as one rule.
  const completed = turnEnd === 'completed'
  return {
    completed,
    turnEnd,
    steeringCount,
    toolCalls,
    summary: finalResponse.slice(0, REPLAY_SUMMARY_MAX_CHARS),
  }
}
