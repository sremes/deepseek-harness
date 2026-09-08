/**
 * SQLite meta store for the session-meta plugin: one row per session plus
 * bounded diagnostic evidence, under `$DSH_HOME/meta/meta.db` (or an
 * explicit `dbPath`, used by tests with `:memory:`).
 *
 * Schema v1 holds sessions + evidence. Schema v2 adds the evaluator budget
 * ledger; schema v3 adds the skill registry; schema v4 adds the replay-run
 * budget ledger; schema v5 adds the skill-sessions history; schema v6 adds
 * the promotions ledger; schema v7 adds the Track B spec-runner ledger.
 * v1/v2/v3/v4/v5/v6
 * databases migrate forward automatically (new tables only — no row
 * rewrites). Anything else throws instead of migrating (repo stance).
 *
 * @module @deepseek-ai/dsh-session-meta/store
 */

import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { EvaluatorLedgerRow, MetaRoute, MetaSessionRow, SkillRegistryRow, SkillStatus, TrackBRunRow } from './types.ts'

/** On-disk schema version; v1/v2/v3/v4/v5/v6 migrate to v7, anything else throws. */
export const META_SCHEMA_VERSION = 7

/** Pipeline-promoted skills start here (probation — one regression archives). */
export const SKILL_PROBATION_CONFIDENCE = 0.4

/** Confidence floor: deltas clamp here and archive the candidate. */
export const SKILL_CONFIDENCE_FLOOR = 0.3

export interface MetaStoreOptions {
  /** Absolute database path, or `:memory:`. Parent directories are created. */
  readonly dbPath: string
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS meta_sessions(
  id TEXT PRIMARY KEY,
  cwd TEXT,
  parent_session TEXT,
  origin TEXT,
  started_at INTEGER NOT NULL,
  ended_at INTEGER NOT NULL,
  events INTEGER NOT NULL,
  tool_calls INTEGER NOT NULL,
  tool_errors TEXT NOT NULL,
  agent_errors TEXT NOT NULL,
  steering_events INTEGER NOT NULL,
  feedback_events INTEGER NOT NULL,
  assistant_messages INTEGER NOT NULL,
  turn_end_reason TEXT,
  route TEXT NOT NULL,
  reasons TEXT NOT NULL,
  dropped_evidence INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS meta_evidence(
  session_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  type TEXT NOT NULL,
  severity TEXT NOT NULL,
  body TEXT NOT NULL,
  PRIMARY KEY(session_id, seq)
);
CREATE TABLE IF NOT EXISTS evaluator_ledger(
  ts INTEGER NOT NULL,
  session_id TEXT NOT NULL,
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  decision TEXT NOT NULL,
  draft_slug TEXT
);
CREATE TABLE IF NOT EXISTS skill_registry(
  trigger_signature TEXT PRIMARY KEY,
  slug TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 0.40,
  applied_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'probation',
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS replay_runs(
  ts INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS skill_sessions(
  trigger_signature TEXT NOT NULL,
  session_id TEXT NOT NULL,
  task_input TEXT NOT NULL,
  ts INTEGER NOT NULL,
  PRIMARY KEY(trigger_signature, session_id)
);
CREATE TABLE IF NOT EXISTS promotions(
  ts INTEGER NOT NULL,
  trigger_signature TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS trackb_runs(
  ts INTEGER NOT NULL,
  file TEXT NOT NULL,
  exit_code INTEGER NOT NULL
);
`

/** Narrow write model: one finished session plus its evidence rows. */
export interface FinishedSession {
  readonly id: string
  readonly cwd: string | null
  readonly parentSession: string | null
  readonly origin: string | null
  readonly startedAt: number
  readonly endedAt: number
  readonly events: number
  readonly toolCalls: number
  readonly toolErrors: readonly string[]
  readonly agentErrors: readonly string[]
  readonly steeringEvents: number
  readonly feedbackEvents: number
  readonly assistantMessages: number
  readonly turnEndReason: string | null
  readonly route: MetaRoute
  readonly reasons: readonly string[]
  readonly droppedEvidence: number
  readonly evidence: ReadonlyArray<{ seq: number; type: string; severity: string; body: string }>
}

export class MetaStore {
  private readonly db: DatabaseSync

  constructor(options: MetaStoreOptions) {
    if (options.dbPath !== ':memory:') mkdirSync(dirname(options.dbPath), { recursive: true })
    this.db = new DatabaseSync(options.dbPath)
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;')
    this.db.exec(SCHEMA_SQL)
    const version = this.db.prepare('PRAGMA user_version').get() as { user_version: number }
    if (version.user_version === 0) {
      this.db.exec(`PRAGMA user_version = ${META_SCHEMA_VERSION}`)
    } else if (version.user_version === 1 || version.user_version === 2 || version.user_version === 3 || version.user_version === 4 || version.user_version === 5 || version.user_version === 6) {
      // v1/v2/v3/v4/v5/v6 → v7 are additive only (evaluator_ledger, skill_registry,
      // replay_runs, skill_sessions, promotions, trackb_runs, created above): stamp forward.
      this.db.exec(`PRAGMA user_version = ${META_SCHEMA_VERSION}`)
    } else if (version.user_version !== META_SCHEMA_VERSION) {
      const seen = version.user_version
      this.db.close()
      throw new Error(`session-meta: unsupported meta.db schema v${seen}, expected v${META_SCHEMA_VERSION}`)
    }
  }

  /** Persist one finished session and its evidence atomically. */
  writeSession(finished: FinishedSession): void {
    const write = this.db.prepare(`
      INSERT INTO meta_sessions(id, cwd, parent_session, origin, started_at, ended_at,
        events, tool_calls, tool_errors, agent_errors, steering_events,
        feedback_events, assistant_messages, turn_end_reason, route, reasons, dropped_evidence)
      VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        cwd=excluded.cwd, parent_session=excluded.parent_session, origin=excluded.origin,
        started_at=excluded.started_at, ended_at=excluded.ended_at, events=excluded.events,
        tool_calls=excluded.tool_calls, tool_errors=excluded.tool_errors,
        agent_errors=excluded.agent_errors, steering_events=excluded.steering_events,
        feedback_events=excluded.feedback_events, assistant_messages=excluded.assistant_messages,
        turn_end_reason=excluded.turn_end_reason, route=excluded.route, reasons=excluded.reasons,
        dropped_evidence=excluded.dropped_evidence`)
    const deleteEvidence = this.db.prepare('DELETE FROM meta_evidence WHERE session_id = ?')
    const insertEvidence = this.db.prepare(
      'INSERT INTO meta_evidence(session_id, seq, type, severity, body) VALUES(?, ?, ?, ?, ?)',
    )
    this.db.exec('BEGIN IMMEDIATE')
    try {
      write.run(
        finished.id, finished.cwd, finished.parentSession, finished.origin, finished.startedAt, finished.endedAt,
        finished.events, finished.toolCalls, JSON.stringify(finished.toolErrors), JSON.stringify(finished.agentErrors),
        finished.steeringEvents, finished.feedbackEvents, finished.assistantMessages, finished.turnEndReason,
        finished.route, JSON.stringify(finished.reasons), finished.droppedEvidence,
      )
      deleteEvidence.run(finished.id)
      for (const evidence of finished.evidence) {
        insertEvidence.run(finished.id, evidence.seq, evidence.type, evidence.severity, evidence.body)
      }
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  /** Read one session row by id. */
  readSession(id: string): MetaSessionRow | undefined {
    const row = this.db.prepare('SELECT * FROM meta_sessions WHERE id = ?').get(id) as Record<string, unknown> | undefined
    if (row === undefined) return undefined
    return {
      id: row['id'] as string,
      cwd: row['cwd'] as string | null,
      parentSession: row['parent_session'] as string | null,
      origin: row['origin'] as string | null,
      startedAt: row['started_at'] as number,
      endedAt: row['ended_at'] as number,
      events: row['events'] as number,
      toolCalls: row['tool_calls'] as number,
      toolErrors: row['tool_errors'] as string,
      agentErrors: row['agent_errors'] as string,
      steeringEvents: row['steering_events'] as number,
      feedbackEvents: row['feedback_events'] as number,
      assistantMessages: row['assistant_messages'] as number,
      turnEndReason: row['turn_end_reason'] as string | null,
      route: row['route'] as MetaRoute,
      reasons: row['reasons'] as string,
      droppedEvidence: row['dropped_evidence'] as number,
    }
  }

  /** Count evidence rows for one session. */
  countEvidence(sessionId: string): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM meta_evidence WHERE session_id = ?').get(sessionId) as { n: number }
    return row.n
  }

  /** Route histogram over all stored sessions (the M1 report primitive). */
  routeHistogram(): Record<MetaRoute, number> {
    const histogram: Record<MetaRoute, number> = { track_a: 0, track_b: 0, no_op: 0 }
    const rows = this.db.prepare('SELECT route, COUNT(*) AS n FROM meta_sessions GROUP BY route').all() as Array<{
      route: MetaRoute
      n: number
    }>
    for (const row of rows) histogram[row.route] = row.n
    return histogram
  }

  /** Record one evaluator attempt (call made, refused, or failed). */
  recordEvaluation(row: EvaluatorLedgerRow): void {
    this.db.prepare(
      'INSERT INTO evaluator_ledger(ts, session_id, input_tokens, output_tokens, decision, draft_slug) VALUES(?, ?, ?, ?, ?, ?)',
    ).run(row.ts, row.sessionId, row.inputTokens, row.outputTokens, row.decision, row.draftSlug)
  }

  /** Evaluator calls recorded at or after `sinceTs` (UTC millis). */
  countEvaluationsSince(sinceTs: number): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM evaluator_ledger WHERE ts >= ?').get(sinceTs) as { n: number }
    return row.n
  }

  /**
   * Record one replay run at `ts` (the L2/L3 replay-run budget ledger).
   *
   * @param ts - run timestamp (UTC millis).
   * @returns No return value; one row is appended.
   */
  recordReplayRun(ts: number): void {
    this.db.prepare('INSERT INTO replay_runs(ts) VALUES(?)').run(ts)
  }

  /**
   * Replay runs recorded at or after `sinceTs` (UTC millis).
   *
   * @param sinceTs - window start (UTC millis).
   * @returns the replay-run count in the window.
   */
  countReplayRunsSince(sinceTs: number): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM replay_runs WHERE ts >= ?').get(sinceTs) as { n: number }
    return row.n
  }

  /**
   * Promotions recorded at or after `sinceTs` (UTC millis).
   *
   * @param sinceTs - window start (UTC millis).
   * @returns the promotion count in the window.
   */
  countPromotionsSince(sinceTs: number): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM promotions WHERE ts >= ?').get(sinceTs) as { n: number }
    return row.n
  }

  /**
   * List every skill-registry row (the M3 post-promotion lifecycle sweep
   * input; Plan-V1 §§3.4/4.2).
   *
   * @returns All registry rows in key order.
   */
  listSkills(): readonly SkillRegistryRow[] {
    const rows = this.db.prepare(
      'SELECT trigger_signature, slug, confidence, applied_count, status, updated_at FROM skill_registry ORDER BY trigger_signature',
    ).all() as Array<Record<string, unknown>>
    return rows.map(row => ({
      triggerSignature: row['trigger_signature'] as string,
      slug: row['slug'] as string,
      confidence: row['confidence'] as number,
      appliedCount: row['applied_count'] as number,
      status: row['status'] as SkillStatus,
      updatedAt: row['updated_at'] as number,
    }))
  }

  /**
   * Look up one skill-registry candidate by trigger signature.
   *
   * @param signature - The candidate `trigger_signature` (the table key).
   * @returns The registry row, or `undefined` when the signature is unknown.
   */
  getSkill(signature: string): SkillRegistryRow | undefined {
    const row = this.db.prepare(
      'SELECT trigger_signature, slug, confidence, applied_count, status, updated_at FROM skill_registry WHERE trigger_signature = ?',
    ).get(signature) as Record<string, unknown> | undefined
    if (row === undefined) return undefined
    return {
      triggerSignature: row['trigger_signature'] as string,
      slug: row['slug'] as string,
      confidence: row['confidence'] as number,
      appliedCount: row['applied_count'] as number,
      status: row['status'] as SkillStatus,
      updatedAt: row['updated_at'] as number,
    }
  }

  /**
   * Promote a candidate skill: upsert at probation confidence. The signature
   * is the key, so one live candidate per signature holds naturally — a
   * different slug for the same signature replaces the previous row.
   * Appends one promotions-ledger row so promotion events and registry
   * rows stay in sync by construction.
   *
   * @param signature - The candidate `trigger_signature`.
   * @param slug - The promoted skill slug.
   * @returns No return value; the row is inserted or fully reset.
   */
  recordPromotion(signature: string, slug: string): void {
    const now = Date.now()
    this.db.prepare(`
      INSERT INTO skill_registry(trigger_signature, slug, confidence, applied_count, status, updated_at)
      VALUES(?, ?, ${SKILL_PROBATION_CONFIDENCE}, 0, 'probation', ?)
      ON CONFLICT(trigger_signature) DO UPDATE SET
        slug=excluded.slug, confidence=excluded.confidence, applied_count=0,
        status=excluded.status, updated_at=excluded.updated_at`).run(signature, slug, now)
    this.db.prepare('INSERT INTO promotions(ts, trigger_signature) VALUES(?, ?)').run(now, signature)
  }

  /**
   * Move a probation candidate to live (M3 promotion wiring — the L2–L4
   * verdicts that justify the call land later; Plan-V1 §4.1).
   *
   * @param signature - The candidate `trigger_signature`.
   * @returns No return value; unknown signatures and non-probation rows are ignored.
   */
  recordLive(signature: string): void {
    this.db.prepare(
      "UPDATE skill_registry SET status = 'live', updated_at = ? WHERE trigger_signature = ? AND status = 'probation'",
    ).run(Date.now(), signature)
  }

  /**
   * Record one verified application of the skill behind a signature.
   *
   * @param signature - The candidate `trigger_signature`.
   * @returns No return value; unknown signatures are ignored.
   */
  recordApplication(signature: string): void {
    this.db.prepare(
      'UPDATE skill_registry SET applied_count = applied_count + 1, updated_at = ? WHERE trigger_signature = ?',
    ).run(Date.now(), signature)
  }

  /**
   * Move a candidate's confidence by `delta`, clamped at `floor`. A move
   * that would land below `floor` pins confidence at `floor` and archives
   * the candidate (Plan-V1 §§3.4/4.2).
   *
   * @param signature - The candidate `trigger_signature`.
   * @param delta - The confidence move (+0.10 explicit positive, −0.15 regression).
   * @param floor - The eviction floor; defaults to `SKILL_CONFIDENCE_FLOOR`.
   * @returns No return value; unknown signatures are ignored.
   */
  applyConfidenceDelta(signature: string, delta: number, floor: number = SKILL_CONFIDENCE_FLOOR): void {
    const current = this.getSkill(signature)
    if (current === undefined) return
    const raw = current.confidence + delta
    if (raw < floor) {
      this.db.prepare(
        "UPDATE skill_registry SET confidence = ?, status = 'archived', updated_at = ? WHERE trigger_signature = ?",
      ).run(floor, Date.now(), signature)
    } else {
      this.db.prepare(
        'UPDATE skill_registry SET confidence = ?, updated_at = ? WHERE trigger_signature = ?',
      ).run(raw, Date.now(), signature)
    }
  }

  /**
   * Record one promoted session's replayable task input behind a signature.
   *
   * @param signature - The promoted `trigger_signature` (the table key).
   * @param sessionId - The promoted session id (one row per signature).
   * @param taskInput - The replayable task input the L2 pair ran.
   * @param ts - Promotion timestamp (UTC millis, newest-first order key).
   * @returns No return value; re-promotion of the same session replaces its row.
   */
  recordPromotionSession(signature: string, sessionId: string, taskInput: string, ts: number): void {
    this.db.prepare(
      'INSERT OR REPLACE INTO skill_sessions(trigger_signature, session_id, task_input, ts) VALUES(?, ?, ?, ?)',
    ).run(signature, sessionId, taskInput, ts)
  }

  /**
   * List past promoted sessions for one signature, newest first.
   *
   * @param signature - The `trigger_signature` to look up.
   * @param limit - Maximum rows to return; values <= 0 yield [].
   * @param excludeSessionId - Session id to exclude (the current session).
   * @returns Up to `limit` past sessions, newest first by ts.
   */
  listPromotionSessions(
    signature: string,
    limit: number,
    excludeSessionId: string,
  ): ReadonlyArray<{ sessionId: string; taskInput: string }> {
    if (limit <= 0) return []
    const rows = this.db.prepare(
      'SELECT session_id, task_input FROM skill_sessions WHERE trigger_signature = ? AND session_id != ? ORDER BY ts DESC LIMIT ?',
    ).all(signature, excludeSessionId, limit) as Array<{ session_id: string; task_input: string }>
    return rows.map(row => ({ sessionId: row.session_id, taskInput: row.task_input }))
  }

  /**
   * Record one Track B spec-runner outcome (the M4 audit trail: pass means
   * the bug still reproduces, nonzero means the characterization failed).
   *
   * @param ts - Run timestamp (UTC millis, newest-first order key).
   * @param file - Emitted spec file the run executed.
   * @param exitCode - Process exit code (-1 on signal/timeout/spawn error).
   * @returns No return value; one row is appended.
   */
  recordTrackBRun(ts: number, file: string, exitCode: number): void {
    this.db.prepare('INSERT INTO trackb_runs(ts, file, exit_code) VALUES(?, ?, ?)').run(ts, file, exitCode)
  }

  /**
   * List spec-runner outcomes for one emitted file, newest first.
   *
   * @param file - The emitted spec file to look up.
   * @param limit - Maximum rows to return (defaults to 10); values <= 0 yield [].
   * @returns Up to `limit` runs, newest first by ts.
   */
  listTrackBRuns(file: string, limit: number = 10): readonly TrackBRunRow[] {
    if (limit <= 0) return []
    const rows = this.db.prepare(
      'SELECT ts, file, exit_code FROM trackb_runs WHERE file = ? ORDER BY ts DESC LIMIT ?',
    ).all(file, limit) as Array<{ ts: number; file: string; exit_code: number }>
    return rows.map(row => ({ ts: row.ts, file: row.file, exitCode: row.exit_code }))
  }

  close(): void {
    this.db.close()
  }
}
