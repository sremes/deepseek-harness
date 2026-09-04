/**
 * Shared types for the session-meta learning-loop input store: triage
 * routes, per-session aggregates, and persisted rows. Runtime code lives in
 * `redact.ts`, `triage.ts`, `store.ts`, and `index.ts`.
 *
 * @module @deepseek-ai/dsh-session-meta/types
 */

/** Deterministic triage route for one session (Plan-V1 §3.2). */
export type MetaRoute = 'track_a' | 'track_b' | 'no_op'

/** Triage verdict with machine-checkable reasons. */
export interface MetaTriage {
  readonly route: MetaRoute
  readonly reasons: readonly string[]
}

/** In-memory per-session aggregate folded from the session firehose. */
export interface SessionAggregate {
  readonly sessionId: string
  readonly cwd?: string | undefined
  readonly parentSession?: string | undefined
  readonly origin?: string | undefined
  readonly startedAt: number
  /** Monotonic event counter (includes events dropped from evidence). */
  eventCount: number
  assistantMessages: number
  toolCalls: number
  /** Distinct tool-error `name` values observed in `tool/result.error`. */
  toolErrors: string[]
  /** Distinct `agent/error` error names. */
  agentErrors: string[]
  /** `user/message` events with a human (`user`-kind) source after the first assistant message. */
  steeringEvents: number
  /** `feedback/record` events observed. */
  feedbackEvents: number
  /** Last `turn/end` reason payload, JSON-encoded. */
  turnEndReason?: string | undefined
  /** Bounded diagnostic evidence rows (errors + steering only). */
  evidence: MetaEvidence[]
  /** Events observed but deliberately not retained as evidence. */
  droppedEvidence: number
}

/** One retained diagnostic evidence row. */
export interface MetaEvidence {
  readonly seq: number
  readonly type: string
  readonly severity: 'info' | 'warn' | 'error'
  readonly body: string
}

/** Persisted `meta_sessions` row shape. */
export interface MetaSessionRow {
  readonly id: string
  readonly cwd: string | null
  readonly parentSession: string | null
  readonly origin: string | null
  readonly startedAt: number
  readonly endedAt: number
  readonly events: number
  readonly toolCalls: number
  readonly toolErrors: string
  readonly agentErrors: string
  readonly steeringEvents: number
  readonly feedbackEvents: number
  readonly assistantMessages: number
  readonly turnEndReason: string | null
  readonly route: MetaRoute
  readonly reasons: string
  readonly droppedEvidence: number
}
