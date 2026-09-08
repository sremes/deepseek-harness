/**
 * Shared types for the session-meta learning loop: triage routes,
 * per-session aggregates, persisted rows, steering records, state
 * projections, evaluator proposals, and gated skill drafts. Runtime code
 * lives in `redact.ts`, `triage.ts`, `store.ts`, `steering.ts`,
 * `projection.ts`, `evaluator.ts`, `writer.ts`, and `index.ts`.
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
  /** Redacted steering message texts (bounded; feeds the Track A evaluator). */
  steeringTexts: string[]
  /** Redacted first human message (the task goal); feeds the projection. */
  openingTask?: string | undefined
  /** Per-tool outcomes in call order (bounded; feeds the projection). */
  toolSteps: ToolStep[]
  /** Tool steps observed after the bound filled. */
  truncatedToolSteps: number
  /** Skill names consulted via the `skill` tool, in order (M2.1: patch-in-place targeting). */
  skillsConsulted: string[]
  /** Assistant-message count when the first steering arrived (M2.2 effort gate). */
  assistantMessagesAtFirstSteering?: number | undefined
  /** Tool-call ids still awaiting their result, mapped to step indexes. */
  pendingToolCalls: Map<string, number>
}

/** One folded tool-call outcome. */
export interface ToolStep {
  readonly tool: string
  ok: boolean
  error?: string | undefined
  /** Redacted, truncated `tool/call.arguments` (M2.1 grounding). */
  args?: string | undefined
  /** Redacted, truncated result text on failed steps (M2.1 grounding). */
  resultDigest?: string | undefined
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

/**
 * Orchestrator-written correction record
 * (`$DSH_HOME/meta/steering/<session-id>.json`, Plan-V1 §3.3): the headless
 * steering source. Interactive sessions steer through in-session
 * user/messages instead; both normalize to the same evaluator input.
 */
export interface SteeringRecord {
  readonly sessionId: string
  readonly originalTask: string
  readonly correction: string
  readonly intentHint?: string | undefined
  readonly verifiedBy?: string | undefined
}

/** One tool step in a state projection. */
export interface ProjectionStep {
  readonly tool: string
  readonly ok: boolean
  readonly error?: string | undefined
  readonly args?: string | undefined
  readonly resultDigest?: string | undefined
  /** A later same-tool step succeeded (M2.2: draft the retry, not the failure). */
  readonly recovered?: boolean | undefined
  /** Args of the later succeeding same-tool step (before/after pair). */
  readonly retryArgs?: string | undefined
}

/**
 * Structured state projection Σ (Plan-V1 §3.3, SKILL.state note): what was
 * done, what changed, what failed — per session, never a global schema.
 * The evaluator sees this plus the steering record, never raw history.
 */
export interface SessionProjection {
  readonly sessionId: string
  readonly goal: string
  readonly steps: readonly ProjectionStep[]
  readonly truncatedSteps: number
  readonly errors: readonly string[]
  readonly turnEnd: string | null
  /** Turn-end kind was `completed` (M2.2: outcome-conditional proposals). */
  readonly completed: boolean
  /** Skill names consulted this session (M2.1: patch-in-place targeting). */
  readonly skillsConsulted: readonly string[]
  readonly steeringTexts: readonly string[]
  readonly counts: {
    readonly events: number
    readonly toolCalls: number
    readonly assistantMessages: number
  }
}

/**
 * Schema-validated evaluator proposal (Plan-V1 §3.3): the model's output is
 * proposal-only; the writer and (in M3) the L0–L4 pipeline decide.
 */
export interface EvaluatorProposal {
  readonly intent: string
  readonly forbidden: readonly string[]
  readonly prescribed: readonly string[]
  readonly triggerSignature: string
  readonly platform: string
  /** When the skill applies; rendered to `whenToUse` (M2.1 retrieval). */
  readonly triggerConditions: string
}

/** A written pipeline-gated skill draft. */
export interface SkillDraft {
  readonly slug: string
  readonly dir: string
  readonly file: string
}

/** One row of the evaluator budget ledger. */
export interface EvaluatorLedgerRow {
  readonly ts: number
  readonly sessionId: string
  readonly inputTokens: number
  readonly outputTokens: number
  readonly decision: string
  readonly draftSlug: string | null
}

/** Lifecycle status of a skill-registry candidate (Plan-V1 §§3.4/4.2). */
export type SkillStatus = 'probation' | 'live' | 'archived'

/** Persisted `skill_registry` row shape, keyed by trigger signature. */
export interface SkillRegistryRow {
  readonly triggerSignature: string
  readonly slug: string
  readonly confidence: number
  readonly appliedCount: number
  readonly status: SkillStatus
  readonly updatedAt: number
}

/** Persisted `trackb_runs` row: one M4 spec-runner outcome per emitted spec. */
export interface TrackBRunRow {
  /** Run timestamp (UTC millis, newest-first order key). */
  readonly ts: number
  /** Emitted spec file the run executed. */
  readonly file: string
  /** Process exit code; -1 on signal death, timeout SIGKILL, or spawn error. */
  readonly exitCode: number
}

/**
 * Plain replay outcome data (M3 L2/L3 seam, Plan-V1 §4.1 + Q15). An SDK
 * adapter later maps `RunResult` events onto this shape; the pipeline only
 * reads these fields.
 */
export interface ReplayOutcome {
  readonly completed: boolean
  readonly turnEnd: string | null
  readonly steeringCount: number
  readonly toolCalls: number
  readonly summary: string
}

/**
 * Structural replay-runner seam (M3 L2/L3, Plan-V1 §4.1 + Q15).
 * `DeepSeekHarness.run` already has this shape (it returns richer data,
 * structurally assignable where it matters); the SDK-backed runner built
 * later implements this interface.
 */
export interface ReplayRunner {
  /**
   * Run one replay of the given task input.
   *
   * @param input - task input to replay.
   * @param options - optional run options carrying the session id and the candidate skill overlay.
   * @returns the replay outcome.
   */
  run(input: string, options?: { sessionId?: string; skillOverlay?: string }): Promise<ReplayOutcome>
}
