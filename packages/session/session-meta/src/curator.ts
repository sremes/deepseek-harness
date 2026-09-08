/**
 * M3 post-promotion lifecycle signals (Plan-V1 §§3.4/4.2): per-session
 * confidence moves plus the 90-day decay sweep. Wires the store lifecycle
 * methods (`recordApplication`, `applyConfidenceDelta`) that promotion left
 * without callers.
 *
 * Signal rules (silence-neutral is load-bearing):
 * - Consulted + steered on its turf → regression (−0.15), never neutral.
 * - Consulted + completed + unsteered → positive (+0.10); the consult came
 *   from an explicit `skill`-tool invocation, so at most one positive per
 *   session holds by construction (one finalize per session).
 * - Consulted + uncompleted + unsteered → neutral: `applied_count` still
 *   increments (the skill was used), but confidence never moves on silence.
 * - Unknown names are ignored (no registry row).
 * - A regression that lands on the confidence floor archives the candidate
 *   (inside `applyConfidenceDelta`); archiving removes the skill directory.
 *
 * @module @deepseek-ai/dsh-session-meta/curator
 */

import { rmSync } from 'node:fs'
import { join } from 'node:path'
import type { MetaStore } from './store.ts'

/** Confidence move for a consulted skill on a completed, unsteered session. */
export const POSITIVE_DELTA = 0.10

/** Confidence move for a consulted skill on a steered session (regression). */
export const REGRESSION_DELTA = -0.15

/** Stale age for the decay sweep: skills untouched this long archive. */
export const DECAY_AGE_MS = 90 * 24 * 3600 * 1000

/** Per-session lifecycle signals; `completed` uses the M2.2 predicate. */
export interface SessionSignals {
  readonly skillsConsulted: readonly string[]
  readonly steeringEvents: number
  readonly completed: boolean
}

/** Log sink for archive removals; the curator never throws into finalize. */
export type CuratorLog = (message: string) => void

/**
 * Fold one finished session into the skill lifecycle: per consulted skill,
 * record the application, then move confidence (regression on steering,
 * positive on completion, neutral on silence). A regression that archives
 * the candidate also removes its skill directory.
 *
 * @param store - skill-registry owner.
 * @param skillsDir - skill-draft root holding one directory per slug.
 * @param log - sink for archive-removal notes.
 * @param signals - consulted skills, steering count, and completion.
 * @returns No return value; unknown names are ignored.
 */
export function applySessionSignals(
  store: MetaStore,
  skillsDir: string,
  log: CuratorLog,
  signals: SessionSignals,
): void {
  const rows = store.listSkills()
  for (const name of signals.skillsConsulted) {
    const row = rows.find(candidate => candidate.slug === name)
    if (row === undefined) continue
    store.recordApplication(row.triggerSignature)
    if (signals.steeringEvents > 0) {
      store.applyConfidenceDelta(row.triggerSignature, REGRESSION_DELTA)
      removeArchivedDir(store, skillsDir, log, row.triggerSignature, row.slug)
    } else if (signals.completed) {
      store.applyConfidenceDelta(row.triggerSignature, POSITIVE_DELTA)
    }
  }
}

/**
 * Archive skills untouched for longer than `DECAY_AGE_MS`: drive confidence
 * to zero so the floor path inside `applyConfidenceDelta` pins and archives,
 * then remove the skill directory.
 *
 * @param store - skill-registry owner.
 * @param skillsDir - skill-draft root holding one directory per slug.
 * @param log - sink for archive-removal notes.
 * @param now - current time (UTC millis); rows older than `now - DECAY_AGE_MS` archive.
 * @returns No return value; archived and fresh rows are untouched.
 */
export function sweepDecay(store: MetaStore, skillsDir: string, log: CuratorLog, now: number): void {
  for (const row of store.listSkills()) {
    if (row.status === 'archived') continue
    if (row.updatedAt >= now - DECAY_AGE_MS) continue
    store.applyConfidenceDelta(row.triggerSignature, -row.confidence)
    removeArchivedDir(store, skillsDir, log, row.triggerSignature, row.slug)
  }
}

/**
 * Remove the skill directory when the registry row has archived. Removal
 * failures log and never throw (finalize must never fail the session).
 */
function removeArchivedDir(
  store: MetaStore,
  skillsDir: string,
  log: CuratorLog,
  signature: string,
  slug: string,
): void {
  if (store.getSkill(signature)?.status !== 'archived') return
  try {
    rmSync(join(skillsDir, slug), { recursive: true, force: true })
  } catch (error) {
    log(`session-meta: failed to remove archived skill dir ${slug}: ${String(error)}`)
  }
}
