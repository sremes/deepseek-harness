/**
 * M3 L1 self-test gate (Plan-V1 §4.1): deterministic check that a proposal's
 * Prescribed Pattern is even weakly operationalizable. A Prescribed clause is
 * mechanically checkable when it either names a tool observed in the
 * motivating session or quotes inline code. Forbidden clauses are out of
 * scope — L0 already covers their bans.
 *
 * @module @deepseek-ai/dsh-session-meta/l1
 */

import type { EvaluatorProposal } from './types.ts'

/** Backtick-quoted inline code span such as `` `path` ``. */
const INLINE_CODE_PATTERN = /`[^`]+`/

// One clause is checkable when it quotes inline code or names a session tool
// (case-insensitive substring match). Empty tool names never match.
function isCheckableClause(clause: string, toolNames: readonly string[]): boolean {
  if (INLINE_CODE_PATTERN.test(clause)) return true
  const lower = clause.toLowerCase()
  return toolNames.some(tool => tool !== '' && lower.includes(tool.toLowerCase()))
}

/**
 * Evaluate one evaluator proposal against the L1 self-test. Pure: the
 * verdict is a mechanical finding over clause text, never a model judgment.
 *
 * @param proposal - schema-validated evaluator proposal under review.
 * @param toolNames - tool names observed in the motivating session.
 * @returns pass true when at least one Prescribed clause is checkable, else one violation.
 */
export function evaluateL1(
  proposal: EvaluatorProposal,
  toolNames: readonly string[],
): { pass: boolean; violations: string[] } {
  const checkable = proposal.prescribed.filter(clause => isCheckableClause(clause, toolNames))
  if (checkable.length > 0) return { pass: true, violations: [] }
  return {
    pass: false,
    violations: ['prescribed: no Prescribed clause is mechanically checkable (name a session tool or quote inline `code`)'],
  }
}
