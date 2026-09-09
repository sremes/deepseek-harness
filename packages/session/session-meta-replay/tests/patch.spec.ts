/**
 * Patch specs: the candidate-overlay `--patch` generator renders a
 * deterministic skill-filesystem mount, rejects empty overlays, and plugs
 * into the runner's existing writer hook without changing the default
 * passthrough.
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session'
import { SdkReplayRunner, generateSkillOverlayPatch } from '../src/index.ts'
import type { ReplayRunFn, ReplayRunOptions, ReplayRunResult } from '../src/types.ts'

/** Scratch roots owned by this suite, removed after each test. */
let root: string | undefined

afterEach(async () => {
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

/**
 * Fresh scratch directory for one test.
 *
 * @returns the scratch directory path.
 */
async function freshDir(): Promise<string> {
  root = await mkdtemp(join(tmpdir(), 'dsh-replay-patch-'))
  if (root === undefined) throw new Error('tmp root missing')
  return root
}

/** One completed `turn/end` event for canned delegate intervals. */
function completedEnd(): SessionEvent {
  return {
    type: 'turn/end',
    seq: SessionSeq(0),
    time: 0,
    data: { turn: 0, reason: { kind: 'completed' } },
  }
}

/** Fake narrow run function recording every call. */
class FakeRunFn implements ReplayRunFn {
  /** Every recorded call in order. */
  readonly calls: Array<{ input: string; options: ReplayRunOptions | undefined }> = []

  /**
   * Record one call.
   *
   * @param input - prompt text to record.
   * @param options - run options to record.
   * @returns an empty completed interval.
   */
  run(input: string, options?: ReplayRunOptions): Promise<ReplayRunResult> {
    this.calls.push({ input, options })
    return Promise.resolve({ events: [completedEnd()], finalResponse: '' })
  }
}

describe('generateSkillOverlayPatch', () => {
  it('renders the overlay as the only skill-filesystem custom root', async () => {
    const dir = await freshDir()
    const file = join(dir, 'candidate.patch.yml')
    expect(generateSkillOverlayPatch('/drafts/fix-headings', file)).toBe(file)
    await expect(readFile(file, 'utf8')).resolves.toBe(
      '- id: skill-filesystem\n  config:\n    customSkillDirs:\n      - "/drafts/fix-headings"\n',
    )
  })

  it('renders byte-identical output on repeat', async () => {
    const dir = await freshDir()
    const first = join(dir, 'first.patch.yml')
    const second = join(dir, 'second.patch.yml')
    generateSkillOverlayPatch('/drafts/fix-headings', first)
    generateSkillOverlayPatch('/drafts/fix-headings', second)
    await expect(readFile(second, 'utf8')).resolves.toBe(await readFile(first, 'utf8'))
  })

  it('escapes overlay directories that need quoting', async () => {
    const dir = await freshDir()
    const file = join(dir, 'quoted.patch.yml')
    const overlay = '/drafts/my "quoted" skill'
    generateSkillOverlayPatch(overlay, file)
    await expect(readFile(file, 'utf8')).resolves.toContain(`      - ${JSON.stringify(overlay)}\n`)
  })

  it.each(['', '   '])('rejects the blank overlay %j by naming it', async (overlay: string) => {
    const dir = await freshDir()
    expect(() => generateSkillOverlayPatch(overlay, join(dir, 'blank.patch.yml'))).toThrow(
      `got ${JSON.stringify(overlay)}`,
    )
  })
})

describe('candidate arm patch mounting', () => {
  it('hands the delegate the patch path when the writer generates it', async () => {
    const dir = await freshDir()
    const patchFile = join(dir, 'candidate.patch.yml')
    const delegate = new FakeRunFn()
    const runner = new SdkReplayRunner(delegate, {
      writePatch: (overlay: string) => generateSkillOverlayPatch(overlay, patchFile),
    })
    await runner.run('task', { sessionId: 's-9', skillOverlay: '/drafts/fix-headings' })
    expect(delegate.calls[0]?.options).toEqual({ sessionId: 's-9', skillOverlay: patchFile })
    await expect(readFile(patchFile, 'utf8')).resolves.toContain('customSkillDirs')
  })
})
