/**
 * Structural replay seam for the SDK-backed L2/L3 driver (Plan-V1 §4.1 +
 * Q15). `ReplayOutcome`/`ReplayRunner` are owned by
 * `@deepseek-ai/dsh-session-meta`'s `replay.ts` and re-exported here as
 * type-only aliases, so this file declares no shape of its own for them.
 * This package still never imports `sdk-client`, `dsh-session`, or `dsh-llm`
 * at runtime — only `SessionEvent` as a type.
 *
 * @module @deepseek-ai/dsh-session-meta-replay/types
 */

import type { SessionEvent } from '@deepseek-ai/dsh-session'

/** Canonical replay outcome data, owned by session-meta's `types.ts` (re-exported from the package root). */
export type { ReplayOutcome, ReplayRunner } from '@deepseek-ai/dsh-session-meta'

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
