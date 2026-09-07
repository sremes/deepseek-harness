import { describe, expect, it } from 'vitest'
import { FakeReplayRunner, buildReplaySummary, compareForHarm } from '../src/replay.ts'
import type { ReplayOutcome } from '../src/replay.ts'

function outcomeFor(overrides: Partial<ReplayOutcome>): ReplayOutcome {
  return {
    completed: true,
    turnEnd: 'completed',
    steeringCount: 0,
    toolCalls: 5,
    summary: 'Ran the checks; all green.',
    ...overrides,
  }
}

describe('FakeReplayRunner', () => {
  it('serves scripted outcomes in order', async () => {
    const first = outcomeFor({ summary: 'first' })
    const second = outcomeFor({ summary: 'second' })
    const runner = new FakeReplayRunner([first, second])
    await expect(runner.run('task')).resolves.toEqual(first)
    await expect(runner.run('task', { sessionId: 's-1' })).resolves.toEqual(second)
  })

  it('throws when the queue is empty', async () => {
    const runner = new FakeReplayRunner([])
    await expect(runner.run('task')).rejects.toThrow('no scripted outcomes')
  })

  it('throws after the scripted outcomes are exhausted', async () => {
    const runner = new FakeReplayRunner([outcomeFor({})])
    await runner.run('task')
    await expect(runner.run('task')).rejects.toThrow('no scripted outcomes')
  })
})

describe('compareForHarm', () => {
  it('vetoes a completed-to-uncompleted regression', () => {
    const result = compareForHarm(
      outcomeFor({ completed: false, turnEnd: 'error' }),
      outcomeFor({ completed: true, turnEnd: 'completed' }),
    )
    expect(result.notWorse).toBe(false)
    expect(result.reasons).toEqual([expect.stringContaining('completed')])
  })

  it('vetoes a steering-count regression', () => {
    const result = compareForHarm(outcomeFor({ steeringCount: 2 }), outcomeFor({ steeringCount: 1 }))
    expect(result.notWorse).toBe(false)
    expect(result.reasons).toEqual([expect.stringContaining('steering')])
  })

  it('passes an uncompleted-to-completed improvement', () => {
    const result = compareForHarm(
      outcomeFor({ completed: true, turnEnd: 'completed' }),
      outcomeFor({ completed: false, turnEnd: 'error' }),
    )
    expect(result).toEqual({ notWorse: true, reasons: [] })
  })

  it('passes a tie', () => {
    const result = compareForHarm(outcomeFor({}), outcomeFor({}))
    expect(result).toEqual({ notWorse: true, reasons: [] })
  })

  it('passes a both-uncompleted tie', () => {
    const result = compareForHarm(
      outcomeFor({ completed: false, turnEnd: 'error' }),
      outcomeFor({ completed: false, turnEnd: 'error' }),
    )
    expect(result).toEqual({ notWorse: true, reasons: [] })
  })

  it('ignores step counts alone', () => {
    const result = compareForHarm(outcomeFor({ toolCalls: 50 }), outcomeFor({ toolCalls: 3 }))
    expect(result).toEqual({ notWorse: true, reasons: [] })
  })
})

describe('buildReplaySummary', () => {
  it('contains the completed line, the counts line, and the body', () => {
    const summary = buildReplaySummary(
      outcomeFor({ completed: true, turnEnd: 'completed', steeringCount: 1, toolCalls: 7, summary: 'Did the thing.' }),
    )
    expect(summary).toContain('completed: true (turnEnd: completed)')
    expect(summary).toContain('steering: 1, toolCalls: 7')
    expect(summary).toContain('Did the thing.')
  })

  it('renders a null turnEnd as none', () => {
    const summary = buildReplaySummary(outcomeFor({ completed: false, turnEnd: null }))
    expect(summary).toContain('completed: false (turnEnd: none)')
  })
})
