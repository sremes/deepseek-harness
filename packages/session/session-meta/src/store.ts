/**
 * SQLite meta store for the session-meta plugin: one row per session plus
 * bounded diagnostic evidence, under `$DSH_HOME/meta/meta.db` (or an
 * explicit `dbPath`, used by tests with `:memory:`).
 *
 * Backends reject old on-disk formats (repo stance) — `PRAGMA user_version`
 * must equal {@link META_SCHEMA_VERSION}; anything else throws instead of
 * migrating.
 *
 * @module @deepseek-ai/dsh-session-meta/store
 */

import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { MetaRoute, MetaSessionRow } from './types.ts'

/** On-disk schema version; mismatches throw (no migration). */
export const META_SCHEMA_VERSION = 1

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

  close(): void {
    this.db.close()
  }
}
