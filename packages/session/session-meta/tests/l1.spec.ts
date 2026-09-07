import { describe, expect, it } from 'vitest'
import { evaluateL1 } from '../src/l1.ts'
import type { EvaluatorProposal } from '../src/types.ts'

function proposalFor(overrides: Partial<EvaluatorProposal>): EvaluatorProposal {
  return {
    intent: 'Confirm destructive paths before running them',
    forbidden: ['Never run rm -rf on unconfirmed paths'],
    prescribed: ['Echo the resolved path and wait for confirmation'],
    triggerSignature: 'destructive-path-confirm',
    triggerConditions: 'Use when a task deletes or overwrites paths outside a scratch directory',
    platform: 'dsh-headless',
    ...overrides,
  }
}

describe('evaluateL1', () => {
  it('passes when a Prescribed clause names a session tool', () => {
    const result = evaluateL1(
      proposalFor({ prescribed: ['Call read with an absolute path before acting'] }),
      ['read', 'edit'],
    )
    expect(result).toEqual({ pass: true, violations: [] })
  })

  it('passes when a Prescribed clause quotes inline code', () => {
    const result = evaluateL1(proposalFor({ prescribed: ['Confirm the `path` before deleting'] }), [])
    expect(result).toEqual({ pass: true, violations: [] })
  })

  it('matches tool names case-insensitively', () => {
    const result = evaluateL1(proposalFor({ prescribed: ['Always READ the file before editing'] }), ['Read'])
    expect(result).toEqual({ pass: true, violations: [] })
  })

  it('fails with one violation when Prescribed is empty', () => {
    const result = evaluateL1(proposalFor({ prescribed: [] }), ['read'])
    expect(result.pass).toBe(false)
    expect(result.violations).toHaveLength(1)
  })

  it('fails with one violation when no clause is checkable', () => {
    const result = evaluateL1(proposalFor({ prescribed: ['Always double-check before proceeding'] }), ['read'])
    expect(result.pass).toBe(false)
    expect(result.violations).toHaveLength(1)
    expect(result.violations).toEqual([expect.stringContaining('prescribed')])
  })

  it('ignores Forbidden clauses when judging checkability', () => {
    const failed = evaluateL1(
      proposalFor({
        forbidden: ['Never run `rm -rf` without calling read first'],
        prescribed: ['Always double-check before proceeding'],
      }),
      ['read'],
    )
    expect(failed.pass).toBe(false)
    expect(failed.violations).toHaveLength(1)
    const passed = evaluateL1(
      proposalFor({
        forbidden: ['Never proceed without care'],
        prescribed: ['Always double-check before proceeding', 'Confirm the `path` first'],
      }),
      [],
    )
    expect(passed).toEqual({ pass: true, violations: [] })
  })
})
