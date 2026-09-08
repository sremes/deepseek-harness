/**
 * Seam specs: the local `ReplayOutcome`/`ReplayRunner` aliases are the
 * canonical session-meta declarations (no local interface of their own),
 * assignable in both directions.
 */

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type * as Canonical from '@deepseek-ai/dsh-session-meta'
import type * as Local from '../src/types.ts'

/** One canned outcome shared by both seams. */
function cannedOutcome(): Canonical.ReplayOutcome {
  return {
    completed: true,
    turnEnd: 'completed',
    steeringCount: 1,
    toolCalls: 2,
    summary: 'done',
  }
}

describe('replay seam aliases', () => {
  it('assigns ReplayOutcome in both directions', () => {
    const canonical: Canonical.ReplayOutcome = cannedOutcome()
    const local: Local.ReplayOutcome = canonical
    const backToCanonical: Canonical.ReplayOutcome = local
    expect(backToCanonical).toEqual(canonical)
  })

  it('assigns ReplayRunner in both directions', async () => {
    const canonicalRunner: Canonical.ReplayRunner = {
      run: async (_input: string) => cannedOutcome(),
    }
    const localRunner: Local.ReplayRunner = canonicalRunner
    const backToCanonicalRunner: Canonical.ReplayRunner = localRunner
    await expect(backToCanonicalRunner.run('task')).resolves.toEqual(cannedOutcome())
  })

  it('declares no local ReplayOutcome/ReplayRunner interface', () => {
    const text = readFileSync(new URL('../src/types.ts', import.meta.url), 'utf8')
    expect(text).not.toContain('interface ReplayOutcome')
    expect(text).not.toContain('interface ReplayRunner')
  })
})
