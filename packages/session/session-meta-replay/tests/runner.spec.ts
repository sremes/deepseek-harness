/**
 * Runner specs: a fake narrow run function pins the candidate/baseline arm
 * routing (overlay passthrough, omission, writer mapping) and the outcome
 * mapping applied to each arm's interval.
 */

import { describe, expect, it } from 'vitest'
import { MessageId } from '@deepseek-ai/dsh-llm'
import { SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session'
import { SdkReplayRunner, mapRunResultToOutcome } from '../src/index.ts'
import type { ReplayRunFn, ReplayRunOptions, ReplayRunResult } from '../src/types.ts'

/** One completed `turn/end` event for canned delegate intervals. */
function completedEnd(seq: number): SessionEvent {
  return {
    type: 'turn/end',
    seq: SessionSeq(seq),
    time: seq,
    data: { turn: 0, reason: { kind: 'completed' } },
  }
}

/** One human `user/message` event for canned delegate intervals. */
function humanUser(seq: number, text: string): SessionEvent {
  return {
    type: 'user/message',
    seq: SessionSeq(seq),
    time: seq,
    data: {
      id: MessageId(`user-${String(seq)}`),
      role: 'user',
      content: [{ type: 'text', text }],
      source: { kind: 'user' },
    },
  }
}

/** Fake narrow run function recording every call and serving one interval. */
class FakeRunFn implements ReplayRunFn {
  readonly calls: Array<{ input: string; options: ReplayRunOptions | undefined }> = []

  /**
   * Record the call and serve the canned interval.
   *
   * @param input - prompt text, recorded.
   * @param options - run options, recorded.
   * @returns the canned interval.
   */
  constructor(private readonly result: ReplayRunResult) {}

  /**
   * Record one call.
   *
   * @param input - prompt text to record.
   * @param options - run options to record.
   * @returns the canned interval.
   */
  run(input: string, options?: ReplayRunOptions): Promise<ReplayRunResult> {
    this.calls.push({ input, options })
    return Promise.resolve(this.result)
  }
}

describe('SdkReplayRunner', () => {
  it('runs the baseline arm without a skillOverlay key', async () => {
    const delegate = new FakeRunFn({ events: [completedEnd(0)], finalResponse: 'baseline done' })
    const runner = new SdkReplayRunner(delegate)
    const outcome = await runner.run('task')
    expect(outcome).toEqual(mapRunResultToOutcome([completedEnd(0)], 'baseline done'))
    expect(delegate.calls).toHaveLength(1)
    expect(delegate.calls[0]?.input).toBe('task')
    const baselineOptions = delegate.calls[0]?.options
    expect(baselineOptions).toEqual({})
    expect(baselineOptions !== undefined && 'skillOverlay' in baselineOptions).toBe(false)
  })

  it('forwards the session id on the baseline arm', async () => {
    const delegate = new FakeRunFn({ events: [], finalResponse: '' })
    const runner = new SdkReplayRunner(delegate)
    await runner.run('task', { sessionId: 's-1' })
    expect(delegate.calls[0]?.options).toEqual({ sessionId: 's-1' })
  })

  it('passes the skill overlay through on the candidate arm', async () => {
    const events = [humanUser(0, 'task'), completedEnd(1)]
    const delegate = new FakeRunFn({ events, finalResponse: 'candidate done' })
    const runner = new SdkReplayRunner(delegate)
    const outcome = await runner.run('task', { skillOverlay: '/drafts/fix-headings' })
    expect(delegate.calls[0]?.options).toEqual({ skillOverlay: '/drafts/fix-headings' })
    expect(outcome).toEqual(mapRunResultToOutcome(events, 'candidate done'))
  })

  it('maps the overlay through the patch writer and keeps the session id', async () => {
    const delegate = new FakeRunFn({ events: [], finalResponse: '' })
    const runner = new SdkReplayRunner(delegate, { writePatch: (overlay: string) => `${overlay}.patch.yml` })
    await runner.run('task', { sessionId: 's-2', skillOverlay: '/drafts/fix-headings' })
    expect(delegate.calls[0]?.options).toEqual({ sessionId: 's-2', skillOverlay: '/drafts/fix-headings.patch.yml' })
  })
})
