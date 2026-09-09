/**
 * Unit coverage for the deterministic triage router: every route and every
 * helper branch, with no cordis involved.
 */

import { describe, expect, it } from 'vitest'
import {
  errorNameOf,
  hasRecoveredErrors,
  isSteeringMessage,
  newAggregate,
  observeAgentError,
  observeToolCall,
  observeToolError,
  observeToolResult,
  triage,
} from '../src/triage.ts'

describe('newAggregate', () => {
  it('starts empty with header lineage attached', () => {
    const aggregate = newAggregate('s1', 1000, { cwd: '/w', parentSession: 'p', origin: 'subagent' })
    expect(aggregate).toMatchObject({
      sessionId: 's1',
      cwd: '/w',
      parentSession: 'p',
      origin: 'subagent',
      eventCount: 0,
      steeringEvents: 0,
      evidence: [],
    })
  })

  it('works without a header', () => {
    expect(newAggregate('s2', 0).cwd).toBeUndefined()
  })
})

describe('isSteeringMessage', () => {
  it('rejects the opening prompt and non-objects', () => {
    expect(isSteeringMessage({ source: { kind: 'user' } }, false)).toBe(false)
    expect(isSteeringMessage(null, true)).toBe(false)
    expect(isSteeringMessage('text', true)).toBe(false)
    expect(isSteeringMessage({}, true)).toBe(false)
    expect(isSteeringMessage({ source: null }, true)).toBe(false)
  })

  it('accepts only human-kind sources', () => {
    expect(isSteeringMessage({ source: { kind: 'user' } }, true)).toBe(true)
    expect(isSteeringMessage({ source: { kind: 'agent-message' } }, true)).toBe(false)
    expect(isSteeringMessage({ source: { kind: 'tool' } }, true)).toBe(false)
    expect(isSteeringMessage({ source: {} }, true)).toBe(false)
  })
})

describe('errorNameOf', () => {
  it('prefers name, falls back to code, then to unknown-error', () => {
    expect(errorNameOf({ name: 'SyntaxError', code: 'E1' })).toBe('SyntaxError')
    expect(errorNameOf({ code: 'E_TOOL' })).toBe('E_TOOL')
    expect(errorNameOf({ name: '', code: '' })).toBe('unknown-error')
    expect(errorNameOf('boom')).toBe('boom')
    expect(errorNameOf('')).toBe('unknown-error')
    expect(errorNameOf(null)).toBe('unknown-error')
    expect(errorNameOf(42)).toBe('unknown-error')
  })
})

describe('triage', () => {
  it('routes silence to no_op with an explicit reason', () => {
    expect(triage(newAggregate('s', 0))).toEqual({ route: 'no_op', reasons: ['no-signal'] })
  })

  it('routes human steering to track_a with a count', () => {
    const aggregate = newAggregate('s', 0)
    aggregate.steeringEvents = 2
    expect(triage(aggregate)).toEqual({ route: 'track_a', reasons: ['steering:2'] })
  })

  it('routes structural errors to track_b', () => {
    for (const name of ['SyntaxError', 'ZodError', 'ERR_TOOL_SCHEMA_VIOLATION']) {
      const aggregate = newAggregate('s', 0)
      observeToolError(aggregate, name)
      const verdict = triage(aggregate)
      expect(verdict.route).toBe('track_b')
      expect(verdict.reasons).toContain(`structural-error:${name}`)
    }
  })

  it('routes generic-only tool errors to track_b via the fallback branch', () => {
    const aggregate = newAggregate('s', 0)
    observeToolError(aggregate, 'E_TIMEOUT')
    const verdict = triage(aggregate)
    expect(verdict.route).toBe('track_b')
    expect(verdict.reasons).toContain('tool-error:E_TIMEOUT')
  })

  it('routes agent errors to track_b', () => {
    const aggregate = newAggregate('s', 0)
    observeAgentError(aggregate, 'ProviderError')
    const verdict = triage(aggregate)
    expect(verdict.route).toBe('track_b')
    expect(verdict.reasons).toContain('agent-error:ProviderError')
  })

  it('routes failed turn ends to track_b but not completed ones', () => {
    const failed = newAggregate('s', 0)
    failed.turnEndReason = JSON.stringify({ kind: 'error', message: 'x' })
    expect(triage(failed).route).toBe('track_b')
    const completed = newAggregate('s', 0)
    completed.turnEndReason = JSON.stringify({ kind: 'completed' })
    expect(triage(completed).route).toBe('no_op')
    const garbage = newAggregate('s', 0)
    garbage.turnEndReason = 'not-json'
    expect(triage(garbage).route).toBe('track_b')
  })

  it('dedupes repeated error names', () => {
    const aggregate = newAggregate('s', 0)
    observeToolError(aggregate, 'SyntaxError')
    observeToolError(aggregate, 'SyntaxError')
    observeAgentError(aggregate, 'E1')
    observeAgentError(aggregate, 'E1')
    expect(aggregate.toolErrors).toEqual(['SyntaxError'])
    expect(aggregate.agentErrors).toEqual(['E1'])
  })

  it('prefers track_b over track_a when both signals exist', () => {
    const aggregate = newAggregate('s', 0)
    aggregate.steeringEvents = 1
    observeToolError(aggregate, 'SyntaxError')
    expect(triage(aggregate).route).toBe('track_b')
  })

  it('tags env-only tool errors with env-blocked and keeps the route', () => {
    for (const name of ['SandboxUnavailableError', 'MISSING_CREDENTIAL']) {
      const aggregate = newAggregate('s', 0)
      observeToolError(aggregate, name)
      const verdict = triage(aggregate)
      expect(verdict.route).toBe('track_b')
      expect(verdict.reasons).toContain('env-blocked')
    }
  })

  it('withholds env-blocked when any non-env signal exists', () => {
    const mixed = newAggregate('s', 0)
    observeToolError(mixed, 'SandboxUnavailableError')
    observeToolError(mixed, 'SyntaxError')
    expect(triage(mixed).reasons).not.toContain('env-blocked')
    const agent = newAggregate('s', 0)
    observeToolError(agent, 'MISSING_CREDENTIAL')
    observeAgentError(agent, 'LlmError')
    expect(triage(agent).reasons).not.toContain('env-blocked')
    const generic = newAggregate('s', 0)
    observeToolError(generic, 'E_TIMEOUT')
    expect(triage(generic).reasons).not.toContain('env-blocked')
  })
})

describe('hasRecoveredErrors', () => {
  it('requires failed steps and full recovery', () => {
    expect(hasRecoveredErrors(newAggregate('s', 0))).toBe(false)
    const clean = newAggregate('s', 0)
    clean.toolSteps.push({ tool: 'read', ok: true })
    expect(hasRecoveredErrors(clean)).toBe(false)
    const partial = newAggregate('s', 0)
    partial.toolSteps.push(
      { tool: 'edit', ok: false, error: 'E1' },
      { tool: 'edit', ok: true },
      { tool: 'write', ok: false, error: 'E2' },
    )
    expect(hasRecoveredErrors(partial)).toBe(false)
    const recovered = newAggregate('s', 0)
    recovered.toolSteps.push({ tool: 'edit', ok: false, error: 'E1' }, { tool: 'edit', ok: true })
    expect(hasRecoveredErrors(recovered)).toBe(true)
  })
})

describe('triage success-recovered routing (M2.2)', () => {
  function flailed(sessionId: string): ReturnType<typeof newAggregate> {
    const aggregate = newAggregate(sessionId, 0)
    observeToolCall(aggregate, { name: 'edit', callId: 'c1', arguments: '{"force":false}' })
    observeToolResult(aggregate, { callId: 'c1', error: { name: 'E_TIMEOUT' } })
    observeToolCall(aggregate, { name: 'edit', callId: 'c2', arguments: '{"force":true}' })
    aggregate.turnEndReason = JSON.stringify({ kind: 'completed' })
    return aggregate
  }

  it('routes flail-then-succeed to track_a with a recovery reason', () => {
    expect(triage(flailed('s'))).toEqual({
      route: 'track_a',
      reasons: ['tool-error:E_TIMEOUT', 'success-recovered'],
    })
  })

  it('keeps recovered structural errors on track_b', () => {
    const aggregate = newAggregate('s', 0)
    observeToolCall(aggregate, { name: 'edit', callId: 'c1' })
    observeToolResult(aggregate, { callId: 'c1', error: { name: 'SyntaxError' } })
    observeToolCall(aggregate, { name: 'edit', callId: 'c2' })
    aggregate.turnEndReason = JSON.stringify({ kind: 'completed' })
    const verdict = triage(aggregate)
    expect(verdict.route).toBe('track_b')
    expect(verdict.reasons).toContain('structural-error:SyntaxError')
  })

  it('keeps unrecovered errors on track_b even when completed', () => {
    const aggregate = newAggregate('s', 0)
    observeToolCall(aggregate, { name: 'edit', callId: 'c1' })
    observeToolResult(aggregate, { callId: 'c1', error: { name: 'E_TIMEOUT' } })
    aggregate.turnEndReason = JSON.stringify({ kind: 'completed' })
    expect(triage(aggregate).route).toBe('track_b')
  })

  it('keeps error names without step evidence on track_b', () => {
    const aggregate = newAggregate('s', 0)
    observeToolError(aggregate, 'E_TIMEOUT')
    aggregate.turnEndReason = JSON.stringify({ kind: 'completed' })
    expect(triage(aggregate).route).toBe('track_b')
  })

  it('adds the steering count alongside the recovery reason', () => {
    const aggregate = flailed('s')
    aggregate.steeringEvents = 2
    expect(triage(aggregate).reasons).toEqual(['tool-error:E_TIMEOUT', 'success-recovered', 'steering:2'])
  })
})
