/**
 * Outcome-mapping specs: hand-built `SessionEvent` arrays in real log
 * shapes (branded seqs, identified messages) pin the completed/steered/
 * tool-call counts and the summary bound.
 */

import { describe, expect, it } from 'vitest'
import { MessageId, ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionSeq, type SessionEvent, type TurnEndReason } from '@deepseek-ai/dsh-session'
import { REPLAY_SUMMARY_MAX_CHARS, mapRunResultToOutcome } from '../src/index.ts'

/** One `turn/start` boundary event: shapes nothing, exercises the open-union fallthrough. */
function turnStart(seq: number): SessionEvent {
  return {
    type: 'turn/start',
    seq: SessionSeq(seq),
    time: seq,
    data: { turn: 0 },
  }
}

/** One human opening/steering `user/message` event. */
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

/** One non-human `user/message` event (plugin notice): never steering. */
function pluginUser(seq: number, text: string): SessionEvent {
  return {
    type: 'user/message',
    seq: SessionSeq(seq),
    time: seq,
    data: {
      id: MessageId(`plugin-${String(seq)}`),
      role: 'user',
      content: [{ type: 'text', text }],
      source: { kind: 'plugin', plugin: 'test-notice' },
    },
  }
}

/** One text-bearing `assistant/message` event. */
function assistant(seq: number, text: string): SessionEvent {
  return {
    type: 'assistant/message',
    seq: SessionSeq(seq),
    time: seq,
    data: {
      turn: 0,
      step: 0,
      message: {
        id: MessageId(`assistant-${String(seq)}`),
        role: 'assistant',
        content: [{ type: 'text', text }],
        source: { kind: 'model', provider: 'test', model: 'test' },
      },
    },
  }
}

/** One `tool/call` event. */
function toolCall(seq: number, callId: string): SessionEvent {
  return {
    type: 'tool/call',
    seq: SessionSeq(seq),
    time: seq,
    data: { turn: 0, step: 0, callId: ToolCallId(callId), name: 'read', arguments: '{}' },
  }
}

/** One `turn/end` event with the given reason. */
function turnEnd(seq: number, reason: TurnEndReason): SessionEvent {
  return {
    type: 'turn/end',
    seq: SessionSeq(seq),
    time: seq,
    data: { turn: 0, reason },
  }
}

describe('mapRunResultToOutcome', () => {
  it('maps a completed run', () => {
    const events = [turnStart(0), humanUser(1, 'do it'), assistant(2, 'done'), toolCall(3, 'c1'), turnEnd(4, { kind: 'completed' })]
    expect(mapRunResultToOutcome(events, 'done')).toEqual({
      completed: true,
      turnEnd: 'completed',
      steeringCount: 0,
      toolCalls: 1,
      summary: 'done',
    })
  })

  it('maps a failed run from a non-completed turn end', () => {
    const events = [humanUser(0, 'do it'), assistant(1, 'partial'), turnEnd(2, { kind: 'blocked' })]
    expect(mapRunResultToOutcome(events, 'partial')).toEqual({
      completed: false,
      turnEnd: 'blocked',
      steeringCount: 0,
      toolCalls: 0,
      summary: 'partial',
    })
  })

  it('counts human steering after the first assistant message only', () => {
    const events = [
      humanUser(0, 'opening task, not steering'),
      assistant(1, 'first draft'),
      humanUser(2, 'fix the heading'),
      pluginUser(3, 'background notice, not steering'),
      humanUser(4, 'also fix the footer'),
      toolCall(5, 'c1'),
      toolCall(6, 'c2'),
      turnEnd(7, { kind: 'completed' }),
    ]
    const outcome = mapRunResultToOutcome(events, 'fixed')
    expect(outcome.completed).toBe(true)
    expect(outcome.turnEnd).toBe('completed')
    expect(outcome.steeringCount).toBe(2)
    expect(outcome.toolCalls).toBe(2)
  })

  it('lets the last turn/end win', () => {
    const events = [turnEnd(0, { kind: 'completed' }), turnEnd(1, { kind: 'blocked' })]
    const outcome = mapRunResultToOutcome(events, '')
    expect(outcome.completed).toBe(false)
    expect(outcome.turnEnd).toBe('blocked')
  })

  it('maps empty events to an uncompleted zero outcome', () => {
    expect(mapRunResultToOutcome([], '')).toEqual({
      completed: false,
      turnEnd: null,
      steeringCount: 0,
      toolCalls: 0,
      summary: '',
    })
  })

  it('truncates the summary to the named bound', () => {
    const finalResponse = 'x'.repeat(REPLAY_SUMMARY_MAX_CHARS + 500)
    const outcome = mapRunResultToOutcome([], finalResponse)
    expect(outcome.summary).toBe(finalResponse.slice(0, REPLAY_SUMMARY_MAX_CHARS))
    expect(outcome.summary).toHaveLength(REPLAY_SUMMARY_MAX_CHARS)
  })
})
