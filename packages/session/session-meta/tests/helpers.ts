/**
 * Shared fakes for the session-meta Track A specs: a valid evaluator
 * proposal, chunk builders for a fake `llm.stream`, and a blank aggregate.
 */

import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import type { SessionAggregate } from '../src/types.ts'

export const VALID_PROPOSAL_JSON = JSON.stringify({
  intent: 'Confirm destructive paths before running them',
  forbidden: ['Never run rm -rf on unconfirmed paths'],
  prescribed: ['Echo the resolved path and wait for confirmation'],
  trigger_signature: 'destructive-path-confirm',
  platform: 'dsh-headless',
})

/** One text-only model turn carrying `text`, with an optional usage report. */
export function textChunks(text: string, usage?: { inputTokens: number; outputTokens: number }): StreamChunk[] {
  const chunks: StreamChunk[] = [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
  ]
  if (usage !== undefined) chunks.push({ type: 'usage', usage })
  chunks.push({ type: 'finish', reason: { kind: 'stop' } })
  return chunks
}

/** One model turn that illegally emits a tool call (evaluator must reject). */
export function toolCallChunks(): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id: ToolCallId('c1'), argumentsDelta: '{}' },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId('c1'), name: 'edit', arguments: '{}' } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

/** Blank aggregate; tests mutate the fields their branch needs. */
export function makeAggregate(sessionId: string): SessionAggregate {
  return {
    sessionId,
    startedAt: Date.now(),
    eventCount: 0,
    assistantMessages: 0,
    toolCalls: 0,
    toolErrors: [],
    agentErrors: [],
    steeringEvents: 0,
    feedbackEvents: 0,
    turnEndReason: undefined,
    evidence: [],
    droppedEvidence: 0,
    steeringTexts: [],
    openingTask: undefined,
    toolSteps: [],
    truncatedToolSteps: 0,
    pendingToolCalls: new Map(),
  }
}
