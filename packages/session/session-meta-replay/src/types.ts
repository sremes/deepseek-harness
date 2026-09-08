/**
 * Structural replay seam for the SDK-backed L2/L3 driver (Plan-V1 §4.1 +
 * Q15). These interfaces mirror `@deepseek-ai/dsh-session-meta`'s
 * `replay.ts` (`ReplayOutcome`/`ReplayRunner`) field-for-field, but are
 * declared locally: that module is not exported from the package root, and
 * this package must never import `sdk-client`, `dsh-session`, or `dsh-llm`
 * at runtime — only `SessionEvent` as a type. The wiring slice publishes
 * the canonical seam or re-exports these; until then this file is the
 * adapter's home for the shape, and any drift from `replay.ts` is a defect
 * in this file.
 *
 * @module @deepseek-ai/dsh-session-meta-replay/types
 */

import type { SessionEvent } from '@deepseek-ai/dsh-session'

/**
 * Plain replay outcome data, mirroring `ReplayOutcome` in
 * `@deepseek-ai/dsh-session-meta`'s `replay.ts`. The evaluation pipeline
 * only reads these fields.
 */
export interface ReplayOutcome {
  /** Whether the replay's last turn ended completed. */
  readonly completed: boolean
  /** The last turn-end reason kind, or null when no turn ended. */
  readonly turnEnd: string | null
  /** Human steering interventions observed after the first assistant message. */
  readonly steeringCount: number
  /** Model-issued tool calls observed during the replay. */
  readonly toolCalls: number
  /** The replay's final response text, truncated to its bound. */
  readonly summary: string
}

/**
 * Per-arm run options, mirroring the `ReplayRunner.run` options in
 * `@deepseek-ai/dsh-session-meta`'s `replay.ts`.
 */
export interface ReplayRunOptions {
  /** Session id to run on; omitted mints a fresh session per call. */
  readonly sessionId?: string
  /** Candidate skill-overlay directory; omitted runs the baseline arm. */
  readonly skillOverlay?: string
}

/**
 * One owned session activity interval: the subset of `RunResult` the
 * outcome mapping reads. `DeepSeekHarness.run` returns a richer value that
 * is structurally assignable here.
 */
export interface ReplayRunResult {
  /** Every `session.event` payload for the run session, in wire order. */
  readonly events: SessionEvent[]
  /** Concatenated text of the run's last assistant message (empty when none). */
  readonly finalResponse: string
}

/**
 * Narrow run function the replay runner drives. `DeepSeekHarness` satisfies
 * this shape structurally without an import: its `run` accepts a wider
 * input and a `RunOptions` supertype of these options (method bivariance
 * plus optional members), and its `RunResult` carries both result fields.
 */
export interface ReplayRunFn {
  /**
   * Run one prompt and settle with the owned activity interval.
   *
   * @param input - prompt text to replay.
   * @param options - optional target session and candidate skill overlay.
   * @returns the run's events plus its final response text.
   */
  run(input: string, options?: ReplayRunOptions): Promise<ReplayRunResult>
}

/**
 * Structural replay-runner seam, mirroring `ReplayRunner` in
 * `@deepseek-ai/dsh-session-meta`'s `replay.ts`. `EvaluationDeps.replayRunner`
 * accepts any implementation of this shape.
 */
export interface ReplayRunner {
  /**
   * Run one replay of the given task input.
   *
   * @param input - task input to replay.
   * @param options - optional run options carrying the session id and the candidate skill overlay.
   * @returns the replay outcome.
   */
  run(input: string, options?: ReplayRunOptions): Promise<ReplayOutcome>
}

/**
 * Optional patch-writer hook: converts a candidate skill-overlay directory
 * into the `skillOverlay` value the delegate run function receives. Absent,
 * the overlay passes through unchanged; the real profile-patch mounting
 * (writing a `--patch` file that appends the overlay to the
 * `skill-filesystem` `customSkillDirs`) lands in the wiring slice.
 */
export interface SdkReplayRunnerOptions {
  /**
   * Map a draft skill directory to the overlay value for the candidate arm.
   *
   * @param skillOverlay - candidate skill-overlay directory from the caller.
   * @returns the overlay value handed to the delegate run function.
   */
  readonly writePatch?: ((skillOverlay: string) => string) | undefined
}
