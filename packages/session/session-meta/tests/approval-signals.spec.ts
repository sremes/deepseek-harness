/**
 * Approval-signal specs: ledger parsing degrades on every malformed shape,
 * gate-vs-human joins are exact by call id, and only session-observed
 * override/uncertain signals become triage reasons (lapses never attach).
 */

import { describe, expect, it } from 'vitest'
import {
  approvalReasonsForSession,
  parseDecisionLine,
  summarizeApprovalSignals,
} from '../src/approval-signals.ts'

function line(record: Record<string, unknown>): string {
  return JSON.stringify(record)
}

const GATE_REJECT = { layer: 'judge', outcome: 'rejected', callId: 'c1', bin: 'npm', ts: 1000 }
const DOWNSTREAM_ALLOW = { layer: 'delegate', outcome: 'allowed-once', reason: 'uncertain', callId: 'c1', ts: 1001 }

describe('parseDecisionLine', () => {
  it('parses usable lines and degrades the rest', () => {
    expect(parseDecisionLine(line(GATE_REJECT))).toMatchObject({ layer: 'judge', outcome: 'rejected', callId: 'c1' })
    expect(parseDecisionLine('')).toBeUndefined()
    expect(parseDecisionLine('   ')).toBeUndefined()
    expect(parseDecisionLine('not json')).toBeUndefined()
    expect(parseDecisionLine('[1,2]')).toBeUndefined()
    expect(parseDecisionLine('"str"')).toBeUndefined()
    expect(parseDecisionLine(line({ outcome: 'rejected' }))).toBeUndefined()
    expect(parseDecisionLine(line({ layer: 'judge' }))).toBeUndefined()
    expect(parseDecisionLine(line({ layer: '', outcome: '' }))).toBeUndefined()
    // Lines without a call id parse (they group nothing downstream).
    expect(parseDecisionLine(line({ layer: 'delegate', outcome: 'unavailable' }))).toMatchObject({ layer: 'delegate' })
  })
})

describe('summarizeApprovalSignals', () => {
  it('joins gate rejection with human approval into override-allow', () => {
    const signals = summarizeApprovalSignals([line(GATE_REJECT), line(DOWNSTREAM_ALLOW)])
    expect(signals).toEqual([{ kind: 'override-allow', callId: 'c1', bin: 'npm', detail: undefined }])
  })

  it('joins gate allowance with human denial into override-deny', () => {
    const signals = summarizeApprovalSignals([
      line({ layer: 'allowlist', outcome: 'allowed-once', callId: 'c2', bin: 'cat', ts: 1000 }),
      line({ layer: 'delegate', outcome: 'rejected', callId: 'c2', ts: 1001 }),
    ])
    expect(signals).toEqual([{ kind: 'override-deny', callId: 'c2', bin: 'cat', detail: undefined }])
  })

  it('classifies uncertain delegations by their downstream outcome', () => {
    const uncertain = { layer: 'judge', outcome: 'uncertain', callId: 'c3', bin: 'npm', grounds: 'jev allow top=0.55', ts: 1000 }
    const allowed = summarizeApprovalSignals([line(uncertain), line({ layer: 'delegate', outcome: 'allowed-once', callId: 'c3', ts: 1001 })])
    expect(allowed[0]?.kind).toBe('uncertain-allowed')
    expect(allowed[0]?.detail).toContain('jev allow top=0.55')
    const confirmed = summarizeApprovalSignals([line(uncertain), line({ layer: 'delegate', outcome: 'rejected', callId: 'c3', ts: 1001 })])
    expect(confirmed[0]?.kind).toBe('uncertain-confirmed')
  })

  it('counts lapses without attaching gate agreement', () => {
    const signals = summarizeApprovalSignals([
      line({ layer: 'delegate', outcome: 'unavailable', callId: 'c4', bin: 'npm', ts: 1000 }),
      line({ layer: 'delegate', outcome: 'cancelled', callId: 'c5', ts: 1001 }),
    ])
    expect(signals).toEqual([
      { kind: 'lapse', callId: 'c4', bin: 'npm' },
      { kind: 'lapse', callId: 'c5', bin: undefined },
    ])
  })

  it('emits nothing for agreement, claims alone, or stale lines', () => {
    expect(summarizeApprovalSignals([
      line({ layer: 'judge', outcome: 'rejected', callId: 'c6', ts: 1000 }),
      line({ layer: 'delegate', outcome: 'rejected', callId: 'c6', ts: 1001 }),
    ])).toEqual([])
    expect(summarizeApprovalSignals([line(GATE_REJECT)])).toEqual([])
    expect(summarizeApprovalSignals([line(GATE_REJECT), line(DOWNSTREAM_ALLOW)], 2000)).toEqual([])
    // Un-timestamped lines pass the window filter; the callId join stays exact.
    expect(summarizeApprovalSignals([
      line({ layer: 'judge', outcome: 'rejected', callId: 'c7' }),
      line({ layer: 'delegate', outcome: 'allowed-once', callId: 'c7' }),
    ], 9999)).toHaveLength(1)
  })

  it('skips lines without a call id', () => {
    expect(summarizeApprovalSignals([
      line({ layer: 'judge', outcome: 'rejected', ts: 1000 }),
      line({ layer: 'delegate', outcome: 'allowed-once', ts: 1001 }),
    ])).toEqual([])
  })
})

describe('approvalReasonsForSession', () => {
  it('attributes only observed non-lapse signals', () => {
    const callIds = new Map([['c1', 0], ['c3', 2]])
    const reasons = approvalReasonsForSession(callIds, [
      { kind: 'override-allow', callId: 'c1', bin: 'npm' },
      { kind: 'override-deny', callId: 'c9', bin: 'cat' },
      { kind: 'uncertain-allowed', callId: 'c3' },
      { kind: 'lapse', callId: 'c1', bin: 'npm' },
      { kind: 'lapse', callId: undefined, bin: 'npm' },
    ])
    expect(reasons).toEqual(['approval-override-allow:npm', 'approval-uncertain-allowed:unknown-bin'])
  })

  it('accepts a set of call ids', () => {
    const reasons = approvalReasonsForSession(new Set(['c1']), [
      { kind: 'override-allow', callId: 'c1', bin: 'npm' },
    ])
    expect(reasons).toEqual(['approval-override-allow:npm'])
  })
})
