/**
 * Selective per-clause composition (Harness² steal #3): union with
 * exact-trimmed-match dedupe, confounded-preferring per-clause verdicts, and
 * the `clause_evidence` store slice. Pure, no live calls.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import {
  composeSkill,
  evidenceMentionsClause,
  parseIncumbentClauses,
  renderComposedSkill,
  resolveClauseEvidence,
} from '../src/compose.ts'
import { META_SCHEMA_VERSION, MetaStore } from '../src/store.ts'
import { renderDraft } from '../src/writer.ts'
import type { EvaluatorProposal } from '../src/types.ts'

function proposal(overrides?: Partial<EvaluatorProposal>): EvaluatorProposal {
  return {
    intent: 'Confirm destructive paths before running them',
    forbidden: ['Never run rm -rf on unconfirmed paths'],
    prescribed: ['Echo the resolved `path` and wait for confirmation'],
    triggerSignature: 'destructive-path-confirm',
    triggerConditions: 'Use when a task deletes or overwrites paths outside a scratch directory',
    platform: 'dsh-headless',
    evidence: ['step 1: `rm` called without confirmation flags', 'step 3: retryArgs added --dry-run before the destructive call'],
    ...overrides,
  }
}

function draftText(): string {
  return renderDraft(proposal(), { sessions: ['s1'], mode: 'headless' }, 'destructive-path-confirm')
}

let store: MetaStore | undefined

afterEach(() => {
  store?.close()
  store = undefined
})

describe('composeSkill union', () => {
  it('unions clauses with exact-trimmed-match dedupe (identical clause not duplicated)', () => {
    const incumbent = parseIncumbentClauses(draftText())
    const composed = composeSkill(incumbent, proposal())
    expect(composed.forbidden).toEqual(['Never run rm -rf on unconfirmed paths'])
    expect(composed.prescribed).toEqual(['Echo the resolved `path` and wait for confirmation'])
    expect(composed.added).toEqual([])
    expect(composed.kept).toEqual([
      'Never run rm -rf on unconfirmed paths',
      'Echo the resolved `path` and wait for confirmation',
    ])
  })

  it('trims ends before dedupe but keeps the incumbent wording', () => {
    const incumbent = { forbidden: ['  Never run rm -rf on unconfirmed paths  '], prescribed: [] as string[] }
    const composed = composeSkill(incumbent, proposal({ prescribed: [] }))
    expect(composed.forbidden).toEqual(['Never run rm -rf on unconfirmed paths'])
    expect(composed.added).toEqual([])
  })

  it('adds only new clauses and keeps sections separate', () => {
    const incumbent = { forbidden: ['Never run rm -rf on unconfirmed paths'], prescribed: [] as string[] }
    const incoming = proposal({
      forbidden: ['Never run rm -rf on unconfirmed paths', 'Never expand `glob` without listing matches first'],
      prescribed: ['Echo the confirmed `path` after listing matches'],
    })
    const composed = composeSkill(incumbent, incoming)
    expect(composed.forbidden).toEqual([
      'Never run rm -rf on unconfirmed paths',
      'Never expand `glob` without listing matches first',
    ])
    expect(composed.prescribed).toEqual(['Echo the confirmed `path` after listing matches'])
    expect(composed.added).toEqual([
      'Never expand `glob` without listing matches first',
      'Echo the confirmed `path` after listing matches',
    ])
    expect(composed.kept).toEqual(['Never run rm -rf on unconfirmed paths'])
  })

  it('does NOT merge near-dupe clauses (open Q11: exact match only)', () => {
    const incumbent = { forbidden: [] as string[], prescribed: ['Echo the resolved path and wait for confirmation'] }
    const incoming = proposal({
      forbidden: [],
      prescribed: ['Echo the resolved path and wait for confirmation.'],
    })
    const composed = composeSkill(incumbent, incoming)
    expect(composed.prescribed).toEqual([
      'Echo the resolved path and wait for confirmation',
      'Echo the resolved path and wait for confirmation.',
    ])
    expect(composed.added).toEqual(['Echo the resolved path and wait for confirmation.'])
  })

  it('drops blanks and the (none recorded) placeholder on both sides', () => {
    const incumbent = { forbidden: ['(none recorded)', '  '], prescribed: ['Real incumbent `path` clause'] }
    const incoming = proposal({ forbidden: ['(none recorded)', ''], prescribed: ['Real incumbent `path` clause', 'New `glob` clause'] })
    const composed = composeSkill(incumbent, incoming)
    expect(composed.forbidden).toEqual([])
    expect(composed.prescribed).toEqual(['Real incumbent `path` clause', 'New `glob` clause'])
    expect(composed.added).toEqual(['New `glob` clause'])
    expect(composed.kept).toEqual(['Real incumbent `path` clause'])
  })
})

describe('parseIncumbentClauses', () => {
  it('reuses the L0 section parser over a rendered draft', () => {
    expect(parseIncumbentClauses(draftText())).toEqual({
      forbidden: ['Never run rm -rf on unconfirmed paths'],
      prescribed: ['Echo the resolved `path` and wait for confirmation'],
    })
  })

  it('maps an empty draft to empty clause lists', () => {
    const text = renderDraft(
      proposal({ forbidden: [], prescribed: [] }),
      { sessions: ['s1'], mode: 'headless' },
      'slug',
    )
    expect(parseIncumbentClauses(text)).toEqual({ forbidden: [], prescribed: [] })
  })
})

describe('resolveClauseEvidence verdicts', () => {
  it('marks single-clause drafts isolated', () => {
    const single = proposal({ forbidden: [], prescribed: ['Verify the `checksum` before publishing'] })
    const rows = resolveClauseEvidence(['Verify the `checksum` before publishing'], single)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.verdict).toBe('isolated')
  })

  it('marks multi-clause drafts confounded (the default)', () => {
    const rows = resolveClauseEvidence(['New `glob` clause'], proposal())
    expect(rows[0]?.verdict).toBe('confounded')
  })

  it('inherits mentioning evidence entries and records unmatched as unmatched', () => {
    const incoming = proposal({
      forbidden: [],
      prescribed: ['Echo the confirmed `path` after listing matches', 'Water the office plants daily'],
      evidence: ['step 2: `glob` expanded without listing matches', 'step 3: retryArgs added --dry-run'],
    })
    const rows = resolveClauseEvidence(
      ['Echo the confirmed `path` after listing matches', 'Water the office plants daily'],
      incoming,
    )
    expect(rows).toHaveLength(2)
    expect(rows[0]?.evidence).toContain('step 2: `glob` expanded without listing matches')
    expect(rows[0]?.verdict).toBe('confounded')
    expect(rows[1]?.evidence).toBe('unmatched')
  })

  it('joins several mentioning entries with newlines', () => {
    const incoming = proposal({
      forbidden: ['Never expand `glob` without listing matches first'],
      prescribed: ['Extra `path` clause'],
      evidence: ['step 1: `glob` matched too much', 'step 2: listing matches first avoided harm'],
    })
    const rows = resolveClauseEvidence(['Never expand `glob` without listing matches first'], incoming)
    expect(rows[0]?.evidence).toBe('step 1: `glob` matched too much\nstep 2: listing matches first avoided harm')
    expect(rows[0]?.verdict).toBe('confounded')
  })

  it('yields no rows when nothing was added', () => {
    expect(resolveClauseEvidence([], proposal())).toEqual([])
  })
})

describe('evidenceMentionsClause', () => {
  it('matches on a shared significant token, case-insensitively', () => {
    expect(evidenceMentionsClause('STEP 2: `glob` expanded', 'Never expand `glob` first')).toBe(true)
  })

  it('ignores short tokens only (no invention from "the"/"and")', () => {
    expect(evidenceMentionsClause('the and of to', 'Do it')).toBe(false)
  })

  it('returns false for an empty clause vocabulary', () => {
    expect(evidenceMentionsClause('step 1: something happened', '!!!')).toBe(false)
  })

  it('returns false without token overlap', () => {
    expect(evidenceMentionsClause('step 1: `rm` called', 'Water the office plants daily')).toBe(false)
  })
})

describe('renderComposedSkill', () => {
  it('replaces only the clause bullets, preserving frontmatter and footer', () => {
    const before = draftText()
    const composed = composeSkill(parseIncumbentClauses(before), proposal({
      prescribed: ['Echo the resolved `path` and wait for confirmation', 'Record the confirmed `path` in notes'],
    }))
    const after = renderComposedSkill(before, composed)
    expect(after).toContain('name: destructive-path-confirm')
    expect(after).toContain('disable-model-invocation: true')
    expect(after).toContain('- Echo the resolved `path` and wait for confirmation')
    expect(after).toContain('- Record the confirmed `path` in notes')
    expect(after.match(/Echo the resolved `path` and wait for confirmation/g)).toHaveLength(1)
  })

  it('emits the (none recorded) placeholder for an empty merged section', () => {
    const before = draftText()
    const after = renderComposedSkill(before, { forbidden: [], prescribed: ['Keep `path` clause'], added: [], kept: [] })
    expect(after).toContain('## Forbidden')
    expect(after).toContain('- (none recorded)')
  })

  it('skips bullets under a later ## heading without touching them', () => {
    const before = [
      '---', 'name: s', '---', '', '## Forbidden', '', '- Old `path` clause', '',
      '## Notes', '', '- keep me', '', '## Prescribed', '', '- Old prescribed `path`', '',
    ].join('\n')
    const after = renderComposedSkill(before, {
      forbidden: ['New forbidden `glob`'],
      prescribed: ['New prescribed `path`'],
      added: [],
      kept: [],
    })
    expect(after).toContain('- New forbidden `glob`')
    expect(after).toContain('- keep me')
    expect(after).toContain('- New prescribed `path`')
    expect(after).not.toContain('- Old `path` clause')
  })

  it('throws when the incumbent file misses sections', () => {
    expect(() => renderComposedSkill('no headings here', { forbidden: [], prescribed: [], added: [], kept: [] })).toThrow(
      /misses Forbidden\/Prescribed/,
    )
  })

  it('throws when only one section is present', () => {
    const forbiddenOnly = ['---', 'name: s', '---', '', '## Forbidden', '', '- Old `path` clause', ''].join('\n')
    expect(() => renderComposedSkill(forbiddenOnly, { forbidden: ['New `glob`'], prescribed: [], added: [], kept: [] })).toThrow(
      /misses Forbidden\/Prescribed/,
    )
  })
})

describe('clause_evidence store', () => {
  it('records and lists rows in clause order', () => {
    store = new MetaStore({ dbPath: ':memory:' })
    const db = store
    expect(db.listClauseEvidence('sig')).toEqual([])
    db.recordClauseEvidence('sig', 'b `glob` clause', 'step 2: `glob` expanded', 'confounded', 200)
    db.recordClauseEvidence('sig', 'a `path` clause', 'unmatched', 'isolated', 100)
    expect(db.listClauseEvidence('sig')).toEqual([
      { signature: 'sig', clause: 'a `path` clause', evidence: 'unmatched', verdict: 'isolated', ts: 100 },
      { signature: 'sig', clause: 'b `glob` clause', evidence: 'step 2: `glob` expanded', verdict: 'confounded', ts: 200 },
    ])
    expect(db.listClauseEvidence('other')).toEqual([])
  })

  it('replaces the row on re-record of the same clause', () => {
    store = new MetaStore({ dbPath: ':memory:' })
    const db = store
    db.recordClauseEvidence('sig', 'clause `path`', 'unmatched', 'confounded', 100)
    db.recordClauseEvidence('sig', 'clause `path`', 'step 1: `path` used', 'isolated', 200)
    expect(db.listClauseEvidence('sig')).toEqual([
      { signature: 'sig', clause: 'clause `path`', evidence: 'step 1: `path` used', verdict: 'isolated', ts: 200 },
    ])
  })

  it('migrates a v8 database forward and stamps v9', async () => {
    let dir: string | undefined
    try {
      dir = await mkdtemp(join(tmpdir(), 'dsh-meta-v8-'))
      const path = join(dir, 'meta.db')
      const legacy = new DatabaseSync(path)
      legacy.exec(
        'CREATE TABLE meta_sessions(id TEXT PRIMARY KEY);'
        + 'CREATE TABLE meta_aggregates(session_id TEXT PRIMARY KEY, aggregate TEXT NOT NULL);'
        + 'PRAGMA user_version = 8;',
      )
      legacy.close()
      store = new MetaStore({ dbPath: path })
      const db = store
      db.recordClauseEvidence('sig', 'clause `path`', 'step 1: `path` used', 'confounded', 100)
      expect(db.listClauseEvidence('sig')).toHaveLength(1)
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
