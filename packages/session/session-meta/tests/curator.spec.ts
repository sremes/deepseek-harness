/**
 * M3 post-promotion lifecycle signals (Plan-V1 §§3.4/4.2): per-session
 * confidence moves plus the 90-day decay sweep, over a real MetaStore and
 * tmp skill directories.
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { applySessionSignals, DECAY_AGE_MS, POSITIVE_DELTA, REGRESSION_DELTA, sweepDecay } from '../src/curator.ts'
import { MetaStore } from '../src/store.ts'

let stores: MetaStore[] = []
let dirs: string[] = []

afterEach(async () => {
  for (const store of stores) store.close()
  stores = []
  for (const dir of dirs) await rm(dir, { recursive: true, force: true })
  dirs = []
})

function freshStore(): MetaStore {
  const store = new MetaStore({ dbPath: ':memory:' })
  stores.push(store)
  return store
}

async function freshSkillsDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-meta-curator-'))
  dirs.push(dir)
  return dir
}

function makeSkillDir(skillsDir: string, slug: string): void {
  const dir = join(skillsDir, slug)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'SKILL.md'), `# ${slug}\n`)
}

describe('protocol constants', () => {
  it('pins the fixed lifecycle numbers', () => {
    expect(POSITIVE_DELTA).toBe(0.10)
    expect(REGRESSION_DELTA).toBe(-0.15)
    expect(DECAY_AGE_MS).toBe(90 * 24 * 3600 * 1000)
  })
})

describe('applySessionSignals', () => {
  it('bumps applied_count and confidence on a completed, unsteered session', async () => {
    const store = freshStore()
    const skillsDir = await freshSkillsDir()
    store.recordPromotion('sig', 'slug')
    makeSkillDir(skillsDir, 'slug')
    const logs: string[] = []
    applySessionSignals(store, skillsDir, message => logs.push(message), {
      skillsConsulted: ['slug'],
      steeringEvents: 0,
      completed: true,
    })
    expect(store.getSkill('sig')).toMatchObject({ appliedCount: 1, status: 'probation' })
    expect(store.getSkill('sig')?.confidence).toBeCloseTo(0.5, 10)
    expect(existsSync(join(skillsDir, 'slug'))).toBe(true)
    expect(logs).toEqual([])
  })

  it('applies a regression above the floor without archiving', async () => {
    const store = freshStore()
    const skillsDir = await freshSkillsDir()
    store.recordPromotion('sig', 'slug')
    makeSkillDir(skillsDir, 'slug')
    const log = (): void => {}
    applySessionSignals(store, skillsDir, log, { skillsConsulted: ['slug'], steeringEvents: 0, completed: true })
    applySessionSignals(store, skillsDir, log, { skillsConsulted: ['slug'], steeringEvents: 2, completed: true })
    expect(store.getSkill('sig')).toMatchObject({ appliedCount: 2, status: 'probation' })
    expect(store.getSkill('sig')?.confidence).toBeCloseTo(0.35, 10)
    expect(existsSync(join(skillsDir, 'slug'))).toBe(true)
  })

  it('leaves confidence alone on silence: uncompleted and unsteered is neutral', async () => {
    const store = freshStore()
    const skillsDir = await freshSkillsDir()
    store.recordPromotion('sig', 'slug')
    applySessionSignals(store, skillsDir, () => {}, {
      skillsConsulted: ['slug'],
      steeringEvents: 0,
      completed: false,
    })
    expect(store.getSkill('sig')).toMatchObject({ appliedCount: 1, confidence: 0.4, status: 'probation' })
  })

  it('ignores unknown skills and empty consults without throwing', async () => {
    const store = freshStore()
    const skillsDir = await freshSkillsDir()
    store.recordPromotion('sig', 'slug')
    expect(() => {
      applySessionSignals(store, skillsDir, () => {}, {
        skillsConsulted: ['missing-slug'],
        steeringEvents: 3,
        completed: true,
      })
      applySessionSignals(store, skillsDir, () => {}, { skillsConsulted: [], steeringEvents: 0, completed: true })
      sweepDecay(store, skillsDir, () => {}, Date.now())
    }).not.toThrow()
    expect(store.getSkill('missing-slug')).toBeUndefined()
    expect(store.getSkill('sig')).toMatchObject({ appliedCount: 0, confidence: 0.4 })
  })

  it('archives and removes the skill dir on a regression to the floor', async () => {
    const store = freshStore()
    const skillsDir = await freshSkillsDir()
    store.recordPromotion('sig', 'slug')
    makeSkillDir(skillsDir, 'slug')
    applySessionSignals(store, skillsDir, () => {}, {
      skillsConsulted: ['slug'],
      steeringEvents: 1,
      completed: false,
    })
    expect(store.getSkill('sig')).toMatchObject({ appliedCount: 1, confidence: 0.3, status: 'archived' })
    expect(existsSync(join(skillsDir, 'slug'))).toBe(false)
  })

  it('logs and never throws when the archived dir cannot be removed', async () => {
    const store = freshStore()
    const skillsDir = await freshSkillsDir()
    store.recordPromotion('sig', 'slug')
    // A NUL byte in the path fails synchronously inside rmSync
    // (ERR_INVALID_ARG_VALUE — force:true cannot suppress it), which
    // exercises the log-and-swallow path deterministically. (NOTE: an
    // ENOTDIR traversal does NOT throw under force:true on modern Node,
    // so a file-as-parent cannot serve as the failure fixture.)
    const badDir = `${skillsDir}\0`
    const logs: string[] = []
    expect(() => {
      applySessionSignals(store, badDir, message => logs.push(message), {
        skillsConsulted: ['slug'],
        steeringEvents: 1,
        completed: false,
      })
    }).not.toThrow()
    expect(store.getSkill('sig')?.status).toBe('archived')
    expect(logs.some(message => message.includes('slug'))).toBe(true)
  })
})

describe('sweepDecay', () => {
  it('archives stale skills and removes their dirs while keeping fresh ones', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-meta-decay-'))
    dirs.push(dir)
    const path = join(dir, 'meta.db')
    const skillsDir = join(dir, 'skills')
    mkdirSync(skillsDir, { recursive: true })
    let store = new MetaStore({ dbPath: path })
    stores.push(store)
    store.recordPromotion('stale-sig', 'stale-slug')
    store.recordPromotion('fresh-sig', 'fresh-slug')
    store.recordPromotion('old-archived-sig', 'old-archived-slug')
    store.applyConfidenceDelta('old-archived-sig', REGRESSION_DELTA)
    expect(store.getSkill('old-archived-sig')?.status).toBe('archived')
    store.close()
    stores = []
    const staleAt = Date.now() - DECAY_AGE_MS - 60_000
    const raw = new DatabaseSync(path)
    try {
      raw.prepare('UPDATE skill_registry SET updated_at = ? WHERE trigger_signature = ?').run(staleAt, 'stale-sig')
      raw.prepare('UPDATE skill_registry SET updated_at = ? WHERE trigger_signature = ?').run(staleAt, 'old-archived-sig')
    } finally {
      raw.close()
    }
    store = new MetaStore({ dbPath: path })
    stores.push(store)
    makeSkillDir(skillsDir, 'stale-slug')
    makeSkillDir(skillsDir, 'fresh-slug')
    makeSkillDir(skillsDir, 'old-archived-slug')
    sweepDecay(store, skillsDir, () => {}, Date.now())
    expect(store.getSkill('stale-sig')).toMatchObject({ status: 'archived' })
    expect(store.getSkill('stale-sig')?.confidence).toBeCloseTo(0.3, 10)
    expect(existsSync(join(skillsDir, 'stale-slug'))).toBe(false)
    expect(store.getSkill('fresh-sig')).toMatchObject({ status: 'probation', confidence: 0.4 })
    expect(existsSync(join(skillsDir, 'fresh-slug'))).toBe(true)
    expect(existsSync(join(skillsDir, 'old-archived-slug'))).toBe(true)
  })
})
