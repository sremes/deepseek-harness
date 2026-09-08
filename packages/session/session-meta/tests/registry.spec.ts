/**
 * Skill-registry store slice: promotion lifecycle persistence (Plan-V1 M3,
 * §§3.4/4.1/4.2). Covers every branch of `recordPromotion`,
 * `recordLive`, `recordApplication`, `applyConfidenceDelta`, and `getSkill`, the
 * replay-run budget ledger, the promotions ledger, the Track B spec-runner
 * ledger, plus the v2 → v3, v3 → v4, v5 → v6, and v6 → v7 migrations.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { META_SCHEMA_VERSION, MetaStore } from '../src/store.ts'

let store: MetaStore | undefined

afterEach(() => {
  store?.close()
  store = undefined
})

function freshStore(): MetaStore {
  store = new MetaStore({ dbPath: ':memory:' })
  return store
}

describe('recordPromotion', () => {
  it('inserts a probation candidate at 0.40 with zero applications', () => {
    const db = freshStore()
    db.recordPromotion('destructive-path-confirm', 'destructive-path-confirm')
    expect(db.getSkill('destructive-path-confirm')).toMatchObject({
      triggerSignature: 'destructive-path-confirm',
      slug: 'destructive-path-confirm',
      confidence: 0.4,
      appliedCount: 0,
      status: 'probation',
    })
    expect(db.getSkill('destructive-path-confirm')?.updatedAt).toEqual(expect.any(Number))
  })

  it('replaces a different slug for the same signature and resets lifecycle state', () => {
    const db = freshStore()
    db.recordPromotion('sig', 'old-slug')
    db.recordApplication('sig')
    db.applyConfidenceDelta('sig', 0.1)
    db.recordPromotion('sig', 'new-slug')
    expect(db.getSkill('sig')).toMatchObject({
      triggerSignature: 'sig',
      slug: 'new-slug',
      confidence: 0.4,
      appliedCount: 0,
      status: 'probation',
    })
  })

  it('re-probations the same slug, resetting confidence and applications', () => {
    const db = freshStore()
    db.recordPromotion('sig', 'slug')
    db.recordApplication('sig')
    db.applyConfidenceDelta('sig', 0.1)
    db.recordPromotion('sig', 'slug')
    expect(db.getSkill('sig')).toMatchObject({ slug: 'slug', confidence: 0.4, appliedCount: 0, status: 'probation' })
  })
})

describe('recordLive', () => {
  it('moves a probation row to live, keeping confidence and applications', () => {
    const db = freshStore()
    db.recordPromotion('sig', 'slug')
    db.recordApplication('sig')
    db.recordLive('sig')
    expect(db.getSkill('sig')).toMatchObject({ slug: 'slug', confidence: 0.4, appliedCount: 1, status: 'live' })
  })

  it('ignores unknown signatures', () => {
    const db = freshStore()
    expect(() => {
      db.recordLive('missing')
    }).not.toThrow()
    expect(db.getSkill('missing')).toBeUndefined()
  })

  it('leaves archived rows untouched', () => {
    const db = freshStore()
    db.recordPromotion('sig', 'slug')
    db.applyConfidenceDelta('sig', -0.15)
    db.recordLive('sig')
    expect(db.getSkill('sig')).toMatchObject({ confidence: 0.3, status: 'archived' })
  })

  it('leaves live rows untouched (idempotent)', () => {
    const db = freshStore()
    db.recordPromotion('sig', 'slug')
    db.recordLive('sig')
    db.recordLive('sig')
    expect(db.getSkill('sig')).toMatchObject({ slug: 'slug', confidence: 0.4, status: 'live' })
  })
})

describe('recordApplication', () => {
  it('increments applied_count per verified application', () => {
    const db = freshStore()
    db.recordPromotion('sig', 'slug')
    db.recordApplication('sig')
    db.recordApplication('sig')
    expect(db.getSkill('sig')?.appliedCount).toBe(2)
  })

  it('ignores unknown signatures', () => {
    const db = freshStore()
    expect(() => {
      db.recordApplication('missing')
    }).not.toThrow()
    expect(db.getSkill('missing')).toBeUndefined()
  })
})

describe('getSkill', () => {
  it('returns undefined for unknown signatures', () => {
    expect(freshStore().getSkill('missing')).toBeUndefined()
  })
})

describe('applyConfidenceDelta', () => {
  it('adds explicit positives while keeping probation status', () => {
    const db = freshStore()
    db.recordPromotion('sig', 'slug')
    db.applyConfidenceDelta('sig', 0.1)
    expect(db.getSkill('sig')?.confidence).toBeCloseTo(0.5, 10)
    expect(db.getSkill('sig')?.status).toBe('probation')
  })

  it('subtracts regressions that stay above the floor without archiving', () => {
    const db = freshStore()
    db.recordPromotion('sig', 'slug')
    db.applyConfidenceDelta('sig', 0.1)
    db.applyConfidenceDelta('sig', -0.15)
    expect(db.getSkill('sig')?.confidence).toBeCloseTo(0.35, 10)
    expect(db.getSkill('sig')?.status).toBe('probation')
  })

  it('clamps at the floor and archives a regression below it', () => {
    const db = freshStore()
    db.recordPromotion('sig', 'slug')
    db.applyConfidenceDelta('sig', -0.15)
    expect(db.getSkill('sig')).toMatchObject({ confidence: 0.3, status: 'archived' })
  })

  it('honours an explicit floor argument', () => {
    const db = freshStore()
    db.recordPromotion('sig', 'slug')
    db.applyConfidenceDelta('sig', -0.05, 0.5)
    expect(db.getSkill('sig')).toMatchObject({ confidence: 0.5, status: 'archived' })
    db.recordPromotion('sig', 'slug')
    db.applyConfidenceDelta('sig', 0.2, 0.5)
    expect(db.getSkill('sig')?.confidence).toBeCloseTo(0.6, 10)
    expect(db.getSkill('sig')?.status).toBe('probation')
  })

  it('ignores unknown signatures', () => {
    const db = freshStore()
    expect(() => {
      db.applyConfidenceDelta('missing', -0.15)
    }).not.toThrow()
    expect(db.getSkill('missing')).toBeUndefined()
  })
})

describe('skill-registry migration', () => {
  it('migrates a v2 database forward and stamps v3', async () => {
    let dir: string | undefined
    try {
      dir = await mkdtemp(join(tmpdir(), 'dsh-meta-v2-'))
      const path = join(dir, 'meta.db')
      const legacy = new DatabaseSync(path)
      legacy.exec(
        'CREATE TABLE meta_sessions(id TEXT PRIMARY KEY); CREATE TABLE evaluator_ledger(ts INTEGER NOT NULL); PRAGMA user_version = 2;',
      )
      legacy.close()
      store = new MetaStore({ dbPath: path })
      const db = store
      db.recordPromotion('sig', 'slug')
      expect(db.getSkill('sig')).toMatchObject({ slug: 'slug', confidence: 0.4, status: 'probation' })
      db.close()
      store = undefined
      const raw = new DatabaseSync(path)
      try {
        const version = raw.prepare('PRAGMA user_version').get() as { user_version: number }
        expect(version.user_version).toBe(META_SCHEMA_VERSION)
      } finally {
        raw.close()
      }
    } finally {
      store?.close()
      store = undefined
      if (dir !== undefined) await rm(dir, { recursive: true, force: true })
    }
  })

  it('stamps fresh databases at the current schema version', async () => {
    let dir: string | undefined
    try {
      dir = await mkdtemp(join(tmpdir(), 'dsh-meta-v3-'))
      const path = join(dir, 'meta.db')
      store = new MetaStore({ dbPath: path })
      store.close()
      store = undefined
      const raw = new DatabaseSync(path)
      try {
        const version = raw.prepare('PRAGMA user_version').get() as { user_version: number }
        expect(version.user_version).toBe(META_SCHEMA_VERSION)
      } finally {
        raw.close()
      }
    } finally {
      if (dir !== undefined) await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('promotions ledger', () => {
  it('appends one row per promote', () => {
    const db = freshStore()
    expect(db.countPromotionsSince(0)).toBe(0)
    db.recordPromotion('sig-a', 'slug-a')
    expect(db.countPromotionsSince(0)).toBe(1)
    db.recordPromotion('sig-b', 'slug-b')
    expect(db.countPromotionsSince(0)).toBe(2)
  })

  it('counts only rows inside the window', () => {
    const db = freshStore()
    db.recordPromotion('sig-a', 'slug-a')
    db.recordPromotion('sig-b', 'slug-b')
    expect(db.countPromotionsSince(0)).toBe(2)
    expect(db.countPromotionsSince(Date.now() + 60_000)).toBe(0)
  })

  it('migrates a v5 database forward and stamps v6', async () => {
    let dir: string | undefined
    try {
      dir = await mkdtemp(join(tmpdir(), 'dsh-meta-v5-'))
      const path = join(dir, 'meta.db')
      const legacy = new DatabaseSync(path)
      legacy.exec(
        'CREATE TABLE meta_sessions(id TEXT PRIMARY KEY); CREATE TABLE evaluator_ledger(ts INTEGER NOT NULL); CREATE TABLE skill_registry(trigger_signature TEXT PRIMARY KEY, slug TEXT NOT NULL, confidence REAL NOT NULL DEFAULT 0.40, applied_count INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT \'probation\', updated_at INTEGER NOT NULL); CREATE TABLE replay_runs(ts INTEGER NOT NULL); CREATE TABLE skill_sessions(trigger_signature TEXT NOT NULL, session_id TEXT NOT NULL, task_input TEXT NOT NULL, ts INTEGER NOT NULL, PRIMARY KEY(trigger_signature, session_id)); PRAGMA user_version = 5;',
      )
      legacy.close()
      store = new MetaStore({ dbPath: path })
      const db = store
      db.recordPromotion('sig', 'slug')
      expect(db.countPromotionsSince(0)).toBe(1)
      expect(db.getSkill('sig')).toMatchObject({ slug: 'slug', status: 'probation' })
      db.close()
      store = undefined
      const raw = new DatabaseSync(path)
      try {
        const version = raw.prepare('PRAGMA user_version').get() as { user_version: number }
        expect(version.user_version).toBe(META_SCHEMA_VERSION)
      } finally {
        raw.close()
      }
    } finally {
      store?.close()
      store = undefined
      if (dir !== undefined) await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('promotion sessions', () => {
  it('lists newest first by ts', () => {
    const db = freshStore()
    db.recordPromotionSession('sig', 's-old', 'task old', 100)
    db.recordPromotionSession('sig', 's-new', 'task new', 300)
    db.recordPromotionSession('sig', 's-mid', 'task mid', 200)
    expect(db.listPromotionSessions('sig', 3, 'current')).toEqual([
      { sessionId: 's-new', taskInput: 'task new' },
      { sessionId: 's-mid', taskInput: 'task mid' },
      { sessionId: 's-old', taskInput: 'task old' },
    ])
  })

  it('excludes the given session', () => {
    const db = freshStore()
    db.recordPromotionSession('sig', 's1', 'task one', 100)
    db.recordPromotionSession('sig', 's2', 'task two', 200)
    expect(db.listPromotionSessions('sig', 3, 's2')).toEqual([{ sessionId: 's1', taskInput: 'task one' }])
  })

  it('caps rows at the limit and yields [] for non-positive limits', () => {
    const db = freshStore()
    db.recordPromotionSession('sig', 's1', 'task one', 100)
    db.recordPromotionSession('sig', 's2', 'task two', 200)
    db.recordPromotionSession('sig', 's3', 'task three', 300)
    expect(db.listPromotionSessions('sig', 2, 'none')).toEqual([
      { sessionId: 's3', taskInput: 'task three' },
      { sessionId: 's2', taskInput: 'task two' },
    ])
    expect(db.listPromotionSessions('sig', 0, 'none')).toEqual([])
    expect(db.listPromotionSessions('sig', -1, 'none')).toEqual([])
  })

  it('replaces the row on re-promote of the same session', () => {
    const db = freshStore()
    db.recordPromotionSession('sig', 's1', 'task one', 100)
    db.recordPromotionSession('sig', 's1', 'task revised', 200)
    expect(db.listPromotionSessions('sig', 3, 'none')).toEqual([{ sessionId: 's1', taskInput: 'task revised' }])
  })
})

describe('replay runs', () => {
  it('counts nothing on a fresh store', () => {
    expect(freshStore().countReplayRunsSince(0)).toBe(0)
  })

  it('records runs and counts them inside the window only', () => {
    const db = freshStore()
    db.recordReplayRun(Date.UTC(2026, 8, 4, 6, 0, 0))
    db.recordReplayRun(Date.UTC(2026, 8, 4, 12, 0, 0))
    expect(db.countReplayRunsSince(Date.UTC(2026, 8, 4))).toBe(2)
    expect(db.countReplayRunsSince(Date.UTC(2026, 8, 4, 12, 0, 0))).toBe(1)
    expect(db.countReplayRunsSince(Date.UTC(2026, 8, 5))).toBe(0)
  })

  it('migrates a v3 database forward and stamps v4', async () => {
    let dir: string | undefined
    try {
      dir = await mkdtemp(join(tmpdir(), 'dsh-meta-v3-'))
      const path = join(dir, 'meta.db')
      const legacy = new DatabaseSync(path)
      legacy.exec(
        'CREATE TABLE meta_sessions(id TEXT PRIMARY KEY); CREATE TABLE evaluator_ledger(ts INTEGER NOT NULL); CREATE TABLE skill_registry(trigger_signature TEXT PRIMARY KEY); PRAGMA user_version = 3;',
      )
      legacy.close()
      store = new MetaStore({ dbPath: path })
      const db = store
      db.recordReplayRun(Date.UTC(2026, 8, 4, 12, 0, 0))
      expect(db.countReplayRunsSince(0)).toBe(1)
      db.close()
      store = undefined
      const raw = new DatabaseSync(path)
      try {
        const version = raw.prepare('PRAGMA user_version').get() as { user_version: number }
        expect(version.user_version).toBe(META_SCHEMA_VERSION)
      } finally {
        raw.close()
      }
    } finally {
      store?.close()
      store = undefined
      if (dir !== undefined) await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('trackb runs', () => {
  it('inserts and lists one file newest first', () => {
    const db = freshStore()
    expect(db.listTrackBRuns('repro.spec.ts')).toEqual([])
    db.recordTrackBRun(100, 'repro.spec.ts', 0)
    db.recordTrackBRun(300, 'repro.spec.ts', 1)
    db.recordTrackBRun(200, 'repro.spec.ts', 0)
    db.recordTrackBRun(400, 'other.spec.ts', 0)
    expect(db.listTrackBRuns('repro.spec.ts')).toEqual([
      { ts: 300, file: 'repro.spec.ts', exitCode: 1 },
      { ts: 200, file: 'repro.spec.ts', exitCode: 0 },
      { ts: 100, file: 'repro.spec.ts', exitCode: 0 },
    ])
    expect(db.listTrackBRuns('other.spec.ts')).toEqual([{ ts: 400, file: 'other.spec.ts', exitCode: 0 }])
  })

  it('caps rows at the limit, defaults to 10, and yields [] for non-positive limits', () => {
    const db = freshStore()
    for (let ts = 1; ts <= 12; ts += 1) {
      db.recordTrackBRun(ts, 'repro.spec.ts', 0)
    }
    expect(db.listTrackBRuns('repro.spec.ts')).toHaveLength(10)
    expect(db.listTrackBRuns('repro.spec.ts').map(row => row.ts)).toEqual([12, 11, 10, 9, 8, 7, 6, 5, 4, 3])
    expect(db.listTrackBRuns('repro.spec.ts', 2).map(row => row.ts)).toEqual([12, 11])
    expect(db.listTrackBRuns('repro.spec.ts', 0)).toEqual([])
    expect(db.listTrackBRuns('repro.spec.ts', -1)).toEqual([])
  })

  it('migrates a v6 database forward and stamps v7', async () => {
    let dir: string | undefined
    try {
      dir = await mkdtemp(join(tmpdir(), 'dsh-meta-v6-'))
      const path = join(dir, 'meta.db')
      const legacy = new DatabaseSync(path)
      // Realistic skeletal v6 database: every table carries its FULL real
      // columns (a skeletal table the test later touches would fail or lie).
      legacy.exec(
        'CREATE TABLE meta_sessions(id TEXT PRIMARY KEY, cwd TEXT, parent_session TEXT, origin TEXT, started_at INTEGER NOT NULL, ended_at INTEGER NOT NULL, events INTEGER NOT NULL, tool_calls INTEGER NOT NULL, tool_errors TEXT NOT NULL, agent_errors TEXT NOT NULL, steering_events INTEGER NOT NULL, feedback_events INTEGER NOT NULL, assistant_messages INTEGER NOT NULL, turn_end_reason TEXT, route TEXT NOT NULL, reasons TEXT NOT NULL, dropped_evidence INTEGER NOT NULL DEFAULT 0);'
        + 'CREATE TABLE meta_evidence(session_id TEXT NOT NULL, seq INTEGER NOT NULL, type TEXT NOT NULL, severity TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(session_id, seq));'
        + 'CREATE TABLE evaluator_ledger(ts INTEGER NOT NULL, session_id TEXT NOT NULL, input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL, decision TEXT NOT NULL, draft_slug TEXT);'
        + 'CREATE TABLE skill_registry(trigger_signature TEXT PRIMARY KEY, slug TEXT NOT NULL, confidence REAL NOT NULL DEFAULT 0.40, applied_count INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT \'probation\', updated_at INTEGER NOT NULL);'
        + 'CREATE TABLE replay_runs(ts INTEGER NOT NULL);'
        + 'CREATE TABLE skill_sessions(trigger_signature TEXT NOT NULL, session_id TEXT NOT NULL, task_input TEXT NOT NULL, ts INTEGER NOT NULL, PRIMARY KEY(trigger_signature, session_id));'
        + 'CREATE TABLE promotions(ts INTEGER NOT NULL, trigger_signature TEXT NOT NULL);'
        + 'PRAGMA user_version = 6;',
      )
      legacy.close()
      store = new MetaStore({ dbPath: path })
      const db = store
      db.recordTrackBRun(100, 'repro.spec.ts', 0)
      db.recordTrackBRun(200, 'repro.spec.ts', -1)
      expect(db.listTrackBRuns('repro.spec.ts')).toEqual([
        { ts: 200, file: 'repro.spec.ts', exitCode: -1 },
        { ts: 100, file: 'repro.spec.ts', exitCode: 0 },
      ])
      db.recordPromotion('sig', 'slug')
      expect(db.getSkill('sig')).toMatchObject({ slug: 'slug', status: 'probation' })
      db.close()
      store = undefined
      const raw = new DatabaseSync(path)
      try {
        const version = raw.prepare('PRAGMA user_version').get() as { user_version: number }
        expect(version.user_version).toBe(META_SCHEMA_VERSION)
      } finally {
        raw.close()
      }
    } finally {
      store?.close()
      store = undefined
      if (dir !== undefined) await rm(dir, { recursive: true, force: true })
    }
  })
})
