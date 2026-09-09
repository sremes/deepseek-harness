/**
 * SDK-backed replay driver for the dsh-meta learning loop (M3 L2/L3,
 * Plan-V1 §4.1 + Q15): the pure `RunResult`-to-outcome mapping plus the
 * candidate/baseline runner over an injected narrow run function. The
 * evaluation pipeline in `@deepseek-ai/dsh-session-meta` receives the
 * runner through `EvaluationDeps.replayRunner`; this package never imports
 * `sdk-client`, `dsh-session`, or `dsh-llm` at runtime (only
 * `SessionEvent` as a type).
 *
 * @module @deepseek-ai/dsh-session-meta-replay
 */

export * from './types.ts'
export * from './outcome.ts'
export * from './runner.ts'
export * from './patch.ts'
