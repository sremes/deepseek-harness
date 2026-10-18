/**
 * Selective per-clause composition (Harness² steal #3): when a draft
 * promotes under an EXISTING trigger_signature, keep the incumbent clauses
 * and add only new ones. Pure: no Cordis, no IO — the orchestrator owns
 * file reads/writes and the store owns clause evidence rows.
 *
 * Dedupe is exact-trimmed-match only. Near-dupes are NOT merged (open Q11:
 * no similarity matching by design) — both wordings are kept.
 *
 * @module @deepseek-ai/dsh-session-meta/compose
 */

import { parseBodySections } from './l0.ts'
import type { EvaluatorProposal } from './types.ts'

/** Parsed incumbent clauses (real clauses only — no `(none recorded)` placeholder). */
export interface IncumbentClauses {
  readonly forbidden: readonly string[]
  readonly prescribed: readonly string[]
}

/** Merged clause lists plus the additive split. */
export interface CompositionResult {
  readonly forbidden: string[]
  readonly prescribed: string[]
  /** Clauses present in the incoming draft but absent from the incumbent. */
  readonly added: string[]
  /** Incumbent real clauses retained in the merged lists. */
  readonly kept: string[]
}

/** Per-clause attribution verdict (Harness² discipline). */
export type ClauseVerdict = 'isolated' | 'confounded'

/** Evidence row for one newly added clause. */
export interface ClauseEvidence {
  readonly clause: string
  readonly evidence: string
  readonly verdict: ClauseVerdict
}

/** Writer placeholder for an empty clause list (mirrors `l0.ts`/`writer.ts`). */
const NONE_RECORDED = '(none recorded)'

/** Normalize one clause for dedupe: exact match after trimming ends only. */
function normalizeClause(clause: string): string {
  return clause.trim()
}

/** Drop blanks and the writer's `(none recorded)` placeholder. */
function realClauses(clauses: readonly string[]): string[] {
  return clauses.map(clause => clause.trim()).filter(clause => clause !== '' && clause !== NONE_RECORDED)
}

/**
 * Parse one incumbent `SKILL.md` file into its real clauses, reusing the
 * existing L0 section parser (no reimplementation).
 *
 * @param skillText - full incumbent `SKILL.md` file text.
 * @returns real forbidden/prescribed clauses (placeholder and blanks removed).
 */
export function parseIncumbentClauses(skillText: string): IncumbentClauses {
  const lines = skillText.split('\n')
  const sections = parseBodySections(lines)
  return { forbidden: realClauses(sections.forbidden), prescribed: realClauses(sections.prescribed) }
}

/**
 * Union incumbent clauses with an incoming proposal. Sections stay separate
 * (forbidden unions forbidden, prescribed unions prescribed); dedupe is
 * exact-trimmed-match only — near-dupes are kept as distinct clauses (open
 * Q11, no similarity matching).
 *
 * @param incumbent - incumbent real clauses.
 * @param incoming - promoting evaluator proposal.
 * @returns merged lists plus `added` (new only) and `kept` (incumbent retained).
 */
export function composeSkill(
  incumbent: IncumbentClauses,
  incoming: EvaluatorProposal,
): CompositionResult {
  const incumbentForbidden = realClauses(incumbent.forbidden)
  const incumbentPrescribed = realClauses(incumbent.prescribed)
  const incomingForbidden = realClauses(incoming.forbidden)
  const incomingPrescribed = realClauses(incoming.prescribed)
  const forbiddenSeen = new Set(incumbentForbidden.map(normalizeClause))
  const prescribedSeen = new Set(incumbentPrescribed.map(normalizeClause))
  const forbidden = [...incumbentForbidden]
  const prescribed = [...incumbentPrescribed]
  const added: string[] = []
  for (const clause of incomingForbidden) {
    const key = normalizeClause(clause)
    if (!forbiddenSeen.has(key)) {
      forbiddenSeen.add(key)
      forbidden.push(clause)
      added.push(clause)
    }
  }
  for (const clause of incomingPrescribed) {
    const key = normalizeClause(clause)
    if (!prescribedSeen.has(key)) {
      prescribedSeen.add(key)
      prescribed.push(clause)
      added.push(clause)
    }
  }
  const kept = [...incumbentForbidden, ...incumbentPrescribed]
  return { forbidden, prescribed, added, kept }
}

/** Lowercase alphanumeric tokens of length >= 4 (the mention-detection vocabulary). */
function significantTokens(text: string): Set<string> {
  const tokens = text.toLowerCase().split(/[^a-z0-9]+/).filter(token => token.length >= 4)
  return new Set(tokens)
}

/**
 * Whether one evidence entry mentions one clause: case-insensitive shared
 * significant token (>= 4 chars). Deliberately lexical, not semantic — a
 * citation supporting clauses in two lenses must still appear in each
 * lens's evidence array to count there (evaluator contract).
 *
 * @param evidence - one `proposal.evidence` entry.
 * @param clause - one added clause.
 * @returns true when they share at least one significant token.
 */
export function evidenceMentionsClause(evidence: string, clause: string): boolean {
  const clauseTokens = significantTokens(clause)
  if (clauseTokens.size === 0) return false
  const evidenceTokens = significantTokens(evidence)
  for (const token of clauseTokens) {
    if (evidenceTokens.has(token)) return true
  }
  return false
}

/**
 * Resolve per-clause evidence for newly added clauses. Each added clause
 * inherits the incoming draft's evidence entries that mention it (joined by
 * newline); clauses nothing mentions record evidence `unmatched`. Verdict is
 * `isolated` ONLY when the promoting draft carried exactly one clause total
 * (prescribed+forbidden combined); otherwise `confounded` — the default,
 * preferred over invented attribution (Harness² discipline).
 *
 * @param added - newly added clauses from `composeSkill(...).added`.
 * @param proposal - the promoting evaluator proposal (evidence source + clause count).
 * @returns one evidence row per added clause.
 */
export function resolveClauseEvidence(
  added: readonly string[],
  proposal: EvaluatorProposal,
): ClauseEvidence[] {
  const total = realClauses(proposal.forbidden).length + realClauses(proposal.prescribed).length
  const verdict: ClauseVerdict = total === 1 ? 'isolated' : 'confounded'
  return added.map((clause) => {
    const matched = proposal.evidence.filter(entry => evidenceMentionsClause(entry, clause))
    return {
      clause,
      evidence: matched.length > 0 ? matched.join('\n') : 'unmatched',
      verdict,
    }
  })
}

/**
 * Rewrite one incumbent `SKILL.md` file with merged clause lists, preserving
 * everything else byte-identical (frontmatter, slug, footer, promotion
 * flag). Only the `- ` bullets under `## Forbidden` / `## Prescribed` are
 * replaced.
 *
 * @param incumbentText - current incumbent file text.
 * @param composed - merged lists from `composeSkill`.
 * @returns the rewritten file text.
 */
export function renderComposedSkill(incumbentText: string, composed: CompositionResult): string {
  const lines = incumbentText.split('\n')
  const out: string[] = []
  let current: 'forbidden' | 'prescribed' | 'none' = 'none'
  let forbiddenEmitted = false
  let prescribedEmitted = false
  const emitBullets = (clauses: readonly string[]): void => {
    if (clauses.length === 0) {
      out.push(`- ${NONE_RECORDED}`)
    } else {
      for (const clause of clauses) out.push(`- ${clause}`)
    }
  }
  for (const raw of lines) {
    const line = raw.trim()
    if (/^##\s+Forbidden\s*$/.test(line)) {
      current = 'forbidden'
      out.push(raw)
      emitBullets(composed.forbidden)
      forbiddenEmitted = true
      continue
    }
    if (/^##\s+Prescribed\s*$/.test(line)) {
      current = 'prescribed'
      out.push(raw)
      emitBullets(composed.prescribed)
      prescribedEmitted = true
      continue
    }
    if (/^##\s+/.test(line)) {
      current = 'none'
      out.push(raw)
      continue
    }
    if (/^\s*-\s+/.test(raw) && (current === 'forbidden' || current === 'prescribed')) {
      continue
    }
    out.push(raw)
  }
  if (!forbiddenEmitted || !prescribedEmitted) {
    throw new Error('session-meta: incumbent skill file misses Forbidden/Prescribed sections')
  }
  return out.join('\n')
}
