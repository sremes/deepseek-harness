/**
 * Shared types for the deterministic-first approval answerer: plugin
 * configuration, judge IO, and the recorded tool-call surface the gate
 * recovers escalated commands from.
 *
 * @module @deepseek-ai/dsh-approval-gate/types
 */

/** Bounded input the judge actually sees: command plus decision context, never a transcript. */
export interface JudgeInput {
  /** Raw `bash -c` string under review, truncated by the caller. */
  readonly command: string
  /** Owning session working directory, or empty when unreadable. */
  readonly cwd: string
  /** Escalation target mode parsed from the ask reason, or `'unknown-mode'`. */
  readonly requestedMode: string
  /** Model justification verbatim from the ask reason. */
  readonly justification: string
}

/** Parsed judge verdict: allow or reject with one clause of grounds. */
export interface JudgeVerdict {
  /** The judge's decision. */
  readonly verdict: 'allow' | 'reject'
  /** One clause of grounds for the decision. */
  readonly grounds: string
}

/** Minimal fetch surface the judge drives (injectable for tests). */
export type JudgeFetch = (url: string, init: {
  method: string
  headers: Record<string, string>
  body: string
  signal: AbortSignal
}) => Promise<{
  ok: boolean
  status: number
  json: () => Promise<unknown>
}>

/** Tool-call record kept per observed call id for command recovery. */
export interface ObservedCall {
  /** Tool name from the call event, when present. */
  readonly tool: unknown
  /** Raw `arguments` string from the call event, when present. */
  readonly args: unknown
}
