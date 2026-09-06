import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import type { EvaluatorProposal } from '../src/types.ts'
import { MAX_DRAFT_DESCRIPTION_CHARS, renderDraft, slugify, writeSkillDraft } from '../src/writer.ts'

const PROPOSAL: EvaluatorProposal = {
  intent: 'Confirm destructive paths before running them',
  forbidden: ['Never run rm -rf on unconfirmed paths'],
  prescribed: ['Echo the resolved path and wait for confirmation'],
  triggerSignature: 'Destructive Path Confirm!',
  triggerConditions: 'Use when a task deletes or overwrites paths outside a scratch directory',
  platform: 'dsh-headless',
}

let root: string | undefined

afterEach(async () => {
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

describe('slugify', () => {
  it.each([
    ['Destructive Path Confirm!', 'destructive-path-confirm'],
    ['--padded--', 'padded'],
    ['a'.repeat(70), 'a'.repeat(60)],
    [`${'b'.repeat(59)} !`, 'b'.repeat(59)],
    ['!!!', 'skill-draft'],
    ['', 'skill-draft'],
  ])('slugifies %s', (input, expected) => {
    expect(slugify(input)).toBe(expected)
  })
})

describe('renderDraft', () => {
  it('renders a gated draft that stays model-disabled', () => {
    const text = renderDraft(PROPOSAL, { sessions: ['s1'], mode: 'headless' }, 'destructive-path-confirm')
    expect(text).toContain('name: destructive-path-confirm')
    expect(text).toContain('disable-model-invocation: true')
    expect(text).toContain('whenToUse: Use when a task deletes or overwrites paths outside a scratch directory')
    expect(text).toContain('confidence_score: 0')
    expect(text).toContain('trigger_signature: Destructive Path Confirm!')
    expect(text).toContain('provenance: {sessions: ["s1"], mode: "headless"}')
    expect(text).toContain('- Never run rm -rf on unconfirmed paths')
    expect(text).toContain('_Platform: dsh-headless.')
  })

  it('marks empty forbidden lists explicitly', () => {
    const text = renderDraft({ ...PROPOSAL, forbidden: [] }, { sessions: [], mode: 'cli' }, 'slug')
    expect(text).toContain('- (none recorded)')
  })

  it('marks empty prescribed lists explicitly', () => {
    const text = renderDraft({ ...PROPOSAL, prescribed: [] }, { sessions: [], mode: 'cli' }, 'slug')
    expect(text).toContain('## Prescribed')
    expect(text).toContain('- (none recorded)')
  })

  it('collapses whitespace and caps the description', () => {
    const text = renderDraft(
      { ...PROPOSAL, intent: `line one\n   line\ttwo ${'x'.repeat(MAX_DRAFT_DESCRIPTION_CHARS + 50)}` },
      { sessions: [], mode: 'cli' },
      'slug',
    )
    const description = text.split('\n').find(line => line.startsWith('description: '))
    expect(description).toBeDefined()
    expect(description).not.toContain('  ')
    expect(description?.length).toBeLessThanOrEqual('description: '.length + MAX_DRAFT_DESCRIPTION_CHARS)
  })
})

describe('writeSkillDraft', () => {
  it('writes SKILL.md exactly once under a unique slug', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-draft-'))
    if (root === undefined) throw new Error('tmp root missing')
    const home: string = root
    const first = writeSkillDraft(home, PROPOSAL, { sessions: ['s1'], mode: 'headless' })
    expect(first.slug).toBe('destructive-path-confirm')
    expect(readFileSync(first.file, 'utf8')).toBe(renderDraft(PROPOSAL, { sessions: ['s1'], mode: 'headless' }, first.slug))
    const second = writeSkillDraft(home, PROPOSAL, { sessions: ['s2'], mode: 'headless' })
    expect(second.slug).toBe('destructive-path-confirm-2')
    expect(existsSync(second.file)).toBe(true)
  })

  it('suffixes past an occupied draft file without touching it', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-draft-'))
    if (root === undefined) throw new Error('tmp root missing')
    const home: string = root
    const dir = join(home, 'destructive-path-confirm')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'SKILL.md'), 'taken')
    const draft = writeSkillDraft(home, PROPOSAL, { sessions: [], mode: 'cli' })
    expect(draft.slug).toBe('destructive-path-confirm-2')
    expect(readFileSync(join(dir, 'SKILL.md'), 'utf8')).toBe('taken')
    expect(existsSync(draft.file)).toBe(true)
  })
})
