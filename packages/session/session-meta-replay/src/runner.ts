/**
 * SDK-backed replay runner for the M3 L2/L3 gates (Plan-V1 §4.1 + Q15):
 * implements the structural `ReplayRunner` seam over an injected narrow run
 * function, so this package never imports `sdk-client` at runtime. The
 * candidate arm carries the skill overlay, the baseline arm omits it, and
 * both arms fold through {@link mapRunResultToOutcome}.
 *
 * @module @deepseek-ai/dsh-session-meta-replay/runner
 */

import { mapRunResultToOutcome } from './outcome.ts'
import type { ReplayOutcome, ReplayRunFn, ReplayRunOptions, ReplayRunner, SdkReplayRunnerOptions } from './types.ts'

/**
 * Replay driver over one SDK run function. The delegate owns process and
 * profile lifetime; this class only routes the overlay per arm and maps the
 * interval onto outcome data.
 */
export class SdkReplayRunner implements ReplayRunner {
  private readonly delegate: ReplayRunFn
  private readonly writePatch: ((skillOverlay: string) => string) | undefined

  /**
   * Capture the delegate run function and the optional overlay writer.
   *
   * @param delegate - narrow run function, structurally satisfied by `DeepSeekHarness`.
   * @param options - optional skill-overlay writer; absorbed into the instance.
   * @returns a runner routing candidate/baseline arms through the delegate.
   */
  constructor(delegate: ReplayRunFn, options?: SdkReplayRunnerOptions) {
    this.delegate = delegate
    this.writePatch = options?.writePatch
  }

  /**
   * Resolve a candidate overlay directory to the value the delegate
   * receives: the writer's mapping when present, else the directory itself.
   * Pass `dir => generateSkillOverlayPatch(dir, patchFile)` (see
   * `./patch.ts`) as the writer to mount the overlay through a generated
   * `--patch` file instead of passing the directory through.
   *
   * @param skillOverlay - candidate skill-overlay directory from the caller.
   * @returns the overlay value handed to the delegate run function.
   */
  private resolveOverlay(skillOverlay: string): string {
    return this.writePatch === undefined ? skillOverlay : this.writePatch(skillOverlay)
  }

  /**
   * Run one replay arm. With a skill overlay this is the candidate arm: the
   * (possibly writer-mapped) overlay passes through to the delegate. Without
   * one this is the baseline arm: the overlay key is omitted entirely.
   *
   * @param input - task input to replay.
   * @param options - optional run options carrying the session id and the candidate skill overlay.
   * @returns the mapped replay outcome.
   */
  async run(input: string, options?: ReplayRunOptions): Promise<ReplayOutcome> {
    const sessionId = options?.sessionId
    const session = sessionId === undefined ? {} : { sessionId }
    const overlay = options?.skillOverlay
    const result = overlay === undefined
      ? await this.delegate.run(input, session)
      : await this.delegate.run(input, { ...session, skillOverlay: this.resolveOverlay(overlay) })
    return mapRunResultToOutcome(result.events, result.finalResponse)
  }
}
