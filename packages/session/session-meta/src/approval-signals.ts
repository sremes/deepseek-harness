/**
 * Approval-outcome signals for the session-meta triage (Valjas loop-close):
 * reads the approval-gate decision ledger (`$DSH_HOME/meta/
 * approver-decisions.jsonl`) and turns gate-vs-human divergences into
 * per-session triage reasons. Pure functions over ledger lines — IO lives
 * with the caller — so every branch is unit-testable without Cordis.
 *
 * Joins are exact: gate assessment and downstream outcome share the ledger
 * `callId`, which is matched against the session's observed tool-call ids.
 * Lines without a call id are skipped (no temporal guessing). Lapses
 * (nobody decided) are counted, never session-attached: an absent human is
 * friction data, not a learnable correction.
 *
 * What each signal means downstream:
 * - `override-allow` — the gate rejected, a human allowed. Strongest
 *   correction: the criteria (or the deterministic layer) is too strict
 *   for this shape. Track A.
 * - `override-deny` — the gate allowed, a human rejected. The gate is too
 *   permissive for this shape. Track A (criteria tightening).
 * - `uncertain-allowed` / `uncertain-confirmed` — Jev was unsure and a
 *   human decided. Calibration data for `escalateBelow`, not a correction.
 * - `lapse` — delegated and nobody decided. Friction corpus only.
 *
 * @module @deepseek-ai/dsh-session-meta/approval-signals
 */

/** One parsed approval-gate ledger line (subset of the gate's record). */
export interface ApprovalDecision {
  /** Which layer produced the line. */
  readonly layer: string
  /** Terminal outcome, or `uncertain` for a Jev assessment awaiting delegation. */
  readonly outcome: string
  /** Delegation cause on `delegate` lines. */
  readonly reason?: string | undefined
  /** Tool-call id joining assessment to downstream outcome. */
  readonly callId?: string | undefined
  /** First command token, for grouping. */
  readonly bin?: string | undefined
  /** Judge grounds / Jev calibration detail. */
  readonly grounds?: string | undefined
  /** Versioned judge model id that answered. */
  readonly judgeModel?: string | undefined
  /** Ledger timestamp. */
  readonly ts?: number | undefined
}

/** Classified gate-vs-human divergence. */
export type ApprovalSignalKind =
  | 'override-allow'
  | 'override-deny'
  | 'uncertain-allowed'
  | 'uncertain-confirmed'
  | 'lapse'

/** One joined signal, ready for triage attribution. */
export interface ApprovalSignal {
  readonly kind: ApprovalSignalKind
  /** Tool-call id, when the signal joins to a session call. */
  readonly callId?: string | undefined
  /** First command token, for grouping. */
  readonly bin?: string | undefined
  /** Human-readable assessment trail (grounds + model). */
  readonly detail?: string | undefined
}

/**
 * Parse one ledger line. Malformed JSON, non-objects, and lines without a
 * usable layer/outcome degrade to `undefined` — the ledger is measurement,
 * never load-bearing.
 *
 * @param line - one JSONL line from the decision ledger.
 * @returns the parsed decision, or undefined when unusable.
 */
export function parseDecisionLine(line: string): ApprovalDecision | undefined {
  if (line.trim() === '') return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const record = parsed as Record<string, unknown>
  if (typeof record['layer'] !== 'string' || record['layer'] === '') return undefined
  if (typeof record['outcome'] !== 'string' || record['outcome'] === '') return undefined
  const str = (key: string): string | undefined =>
    typeof record[key] === 'string' && record[key] !== '' ? (record[key] as string) : undefined
  const ts = typeof record['ts'] === 'number' && Number.isFinite(record['ts']) ? record['ts'] : undefined
  return {
    layer: record['layer'] as string,
    outcome: record['outcome'] as string,
    reason: str('reason'),
    callId: str('callId'),
    bin: str('bin'),
    grounds: str('grounds'),
    judgeModel: str('judgeModel'),
    ts,
  }
}

/**
 * Join ledger lines into per-ask signals. Gate assessments (claimed lines)
 * pair with their delegation line by `callId`; claimed lines without a
 * delegation are terminal by construction (the waterfall short-circuited).
 * Lines older than `since` (ledger millis) are ignored so a session never
 * re-attaches ancient history.
 *
 * @param lines - raw ledger lines, oldest first (order irrelevant).
 * @param since - ignore lines with an older timestamp; un-timestamped lines
 *   always pass the filter (fail-open toward recall, the callId join stays
 *   the exactness gate).
 * @returns classified signals, one per joined ask plus one per lapse line.
 */
export function summarizeApprovalSignals(lines: string[], since?: number): ApprovalSignal[] {
  const gate = new Map<string, ApprovalDecision>()
  const terminal = new Map<string, ApprovalDecision>()
  for (const line of lines) {
    const decision = parseDecisionLine(line)
    if (decision === undefined || decision.callId === undefined) continue
    if (since !== undefined && decision.ts !== undefined && decision.ts < since) continue
    if (decision.layer === 'delegate') {
      terminal.set(decision.callId, decision)
    } else if (!gate.has(decision.callId)) {
      gate.set(decision.callId, decision)
    }
  }
  const signals: ApprovalSignal[] = []
  const seen = new Set<string>([...gate.keys(), ...terminal.keys()])
  for (const callId of seen) {
    const assessment = gate.get(callId)
    const end = terminal.get(callId)
    const shape = assessment?.bin ?? end?.bin
    if (assessment === undefined) {
      // Delegated with no gate claim: only lapses carry information.
      if (end !== undefined && (end.outcome === 'unavailable' || end.outcome === 'cancelled')) {
        signals.push({ kind: 'lapse', callId, bin: shape })
      }
      continue
    }
    if (end === undefined) continue
    const gateRejected = assessment.outcome === 'rejected'
    const gateAllowed = assessment.outcome === 'allowed-once'
    const detail = assessment.grounds !== undefined
      ? `${assessment.grounds}${assessment.judgeModel !== undefined ? ` [${assessment.judgeModel}]` : ''}`
      : undefined
    if (gateRejected && end.outcome === 'allowed-once') {
      signals.push({ kind: 'override-allow', callId, bin: shape, detail })
    } else if (gateAllowed && end.outcome === 'rejected') {
      signals.push({ kind: 'override-deny', callId, bin: shape, detail })
    } else if (assessment.outcome === 'uncertain' && end.outcome === 'allowed-once') {
      signals.push({ kind: 'uncertain-allowed', callId, bin: shape, detail })
    } else if (assessment.outcome === 'uncertain' && end.outcome === 'rejected') {
      signals.push({ kind: 'uncertain-confirmed', callId, bin: shape, detail })
    } else if (end.outcome === 'unavailable' || end.outcome === 'cancelled') {
      signals.push({ kind: 'lapse', callId, bin: shape })
    }
  }
  return signals
}

/**
 * Triage reasons for the approval signals that touch this session: only
 * signals whose call id the session actually observed. Lapses are excluded
 * (friction, not correction). Pure over the aggregate's call-id map.
 *
 * @param callIds - tool-call ids the session observed (the aggregate map).
 * @param signals - classified approval signals.
 * @returns triage reason strings, e.g. `approval-override-allow:npm`.
 */
export function approvalReasonsForSession(
  callIds: ReadonlyMap<string, unknown> | ReadonlySet<string>,
  signals: ApprovalSignal[],
): string[] {
  const has = (callId: string | undefined): boolean =>
    callId !== undefined && (callIds instanceof Map ? callIds.has(callId) : (callIds as ReadonlySet<string>).has(callId))
  const reasons: string[] = []
  for (const signal of signals) {
    if (signal.kind === 'lapse' || !has(signal.callId)) continue
    reasons.push(`approval-${signal.kind}:${signal.bin ?? 'unknown-bin'}`)
  }
  return reasons
}
