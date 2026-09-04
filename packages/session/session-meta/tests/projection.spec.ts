import { describe, expect, it } from 'vitest'
import { DEFAULT_PROJECTION_STEPS, projectSession } from '../src/projection.ts'
import { makeAggregate } from './helpers.ts'

describe('projectSession', () => {
  it('projects an empty aggregate with an unknown goal', () => {
    const projection = projectSession(makeAggregate('s1'))
    expect(projection).toEqual({
      sessionId: 's1',
      goal: '(unknown goal)',
      steps: [],
      truncatedSteps: 0,
      errors: [],
      turnEnd: null,
      steeringTexts: [],
      counts: { events: 0, toolCalls: 0, assistantMessages: 0 },
    })
  })

  it('keeps the most recent steps and counts the rest as truncated', () => {
    const aggregate = makeAggregate('s1')
    aggregate.openingTask = 'ship it'
    for (let n = 0; n < DEFAULT_PROJECTION_STEPS + 5; n += 1) {
      aggregate.toolSteps.push({ tool: `tool-${n}`, ok: true })
    }
    aggregate.truncatedToolSteps = 3
    aggregate.turnEndReason = JSON.stringify({ reason: 'done' })
    const projection = projectSession(aggregate)
    expect(projection.goal).toBe('ship it')
    expect(projection.steps).toHaveLength(DEFAULT_PROJECTION_STEPS)
    expect(projection.steps[0]?.tool).toBe('tool-5')
    expect(projection.truncatedSteps).toBe(8)
    expect(projection.turnEnd).toBe(JSON.stringify({ reason: 'done' }))
  })

  it('carries tool errors with their names and merges both error lists', () => {
    const aggregate = makeAggregate('s1')
    aggregate.toolSteps.push({ tool: 'edit', ok: false, error: 'EditFailed' }, { tool: 'read', ok: true })
    aggregate.toolErrors.push('EditFailed')
    aggregate.agentErrors.push('LlmError')
    const projection = projectSession(aggregate)
    expect(projection.steps[0]).toEqual({ tool: 'edit', ok: false, error: 'EditFailed' })
    expect(projection.steps[1]).toEqual({ tool: 'read', ok: true })
    expect(projection.errors).toEqual(['EditFailed', 'LlmError'])
  })

  it('copies steering texts and counts', () => {
    const aggregate = makeAggregate('s1')
    aggregate.steeringTexts.push('not like that')
    aggregate.eventCount = 9
    aggregate.toolCalls = 2
    aggregate.assistantMessages = 1
    const projection = projectSession(aggregate)
    expect(projection.steeringTexts).toEqual(['not like that'])
    expect(projection.counts).toEqual({ events: 9, toolCalls: 2, assistantMessages: 1 })
  })
})
