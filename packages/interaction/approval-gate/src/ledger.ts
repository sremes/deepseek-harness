/**
 * Decision ledger for the approval gate: one append-only JSONL line per
 * answered ask under `<dshHome>/meta/approver-decisions.jsonl`. This is the
 * measurement foundation for expiry/lapse analysis (delegated asks that come
 * back `unavailable`/`cancelled` = no human decided) and for judge tuning
 * (verdicts with grounds, joinable against later human decisions).
 *
 * Redaction guarantee: the raw command is NEVER stored. Only its shape —
 * first token, argument count, metacharacter presence — lands in the file,
 * so leaked secrets in a command cannot end up in the ledger.
 *
 * Failure posture: `recordDecision` never throws. A broken ledger must not
 * wedge approvals; the worst case is a missing line.
 *
 * @module @deepseek-ai/dsh-approval-gate/ledger
 */

import { appendFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'

/** Ledger file name inside the `meta` directory of the task home. */
export const DECISIONS_FILE = 'approver-decisions.jsonl'

/** Shell metacharacters, mirroring the allowlist ban in `gate.ts`. */
const META_CHARS = /[;&|><`$(){}[\]!#~*?]/

/** Decision layers that can claim or delegate an ask. */
export type DecisionLayer = 'blacklist' | 'allowlist' | 'judge' | 'delegate'

/** Why a delegation happened (which fall-through fired). */
export type DelegateReason =
  | 'non-bash'
  | 'unrecoverable'
  | 'no-key'
  | 'budget-spent'
  | 'judge-fault'
  | 'uncertain'
  | 'exception'

/** One ledger line. `outcome` is the gate's own answer, except on `delegate`
 * where it is the downstream waterfall result (`unavailable`/`cancelled` =
 * nobody decided — the lapse signal). */
export interface DecisionRecord {
  /** Millis epoch of the decision. */
  readonly ts: number
  /** Which layer produced this line. */
  readonly layer: DecisionLayer
  /** Terminal outcome of the ask. */
  readonly outcome: string
  /** Delegation cause; present only on `delegate` lines. */
  readonly reason?: DelegateReason | undefined
  /** First whitespace-delimited token of the command, when recoverable. */
  readonly bin?: string | undefined
  /** Whitespace-delimited token count, when recoverable. */
  readonly argc?: number | undefined
  /** Whether the command carried shell metacharacters. */
  readonly metachars?: boolean | undefined
  /** Judge grounds verbatim (one clause, no command text). */
  readonly grounds?: string | undefined
  /** Judge model id, on `judge` lines. */
  readonly judgeModel?: string | undefined
  /** Judge round-trip millis, on judged or judge-fault lines. */
  readonly latencyMs?: number | undefined
}

/**
 * Reduce a command to its storable shape. Pure: unit-covered.
 *
 * @param command - raw `bash -c` string.
 * @returns first token, token count, and metacharacter presence.
 */
export function classifyCommand(command: string): { bin: string; argc: number; metachars: boolean } {
  const tokens = command.trim().split(/\s+/).filter(part => part !== '')
  return {
    bin: tokens[0] ?? '',
    argc: tokens.length,
    metachars: META_CHARS.test(command),
  }
}

/**
 * Append one decision line. Never throws: every IO fault (missing home,
 * read-only fs, a file where the directory should be) resolves silently.
 *
 * @param home - harness home holding the `meta` directory.
 * @param record - the decision line (without timestamp when the caller
 *   wants the live clock; `ts` defaults to `Date.now()`).
 */
export async function recordDecision(
  home: string,
  record: Omit<DecisionRecord, 'ts'> & { ts?: number },
): Promise<void> {
  try {
    await mkdir(join(home, 'meta'), { recursive: true })
    await appendFile(
      join(home, 'meta', DECISIONS_FILE),
      JSON.stringify({ ts: Date.now(), ...record }) + '\n',
      'utf8',
    )
  } catch {
    // The ledger is measurement only — swallow everything.
  }
}
