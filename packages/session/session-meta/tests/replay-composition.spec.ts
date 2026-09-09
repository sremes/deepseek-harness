/**
 * Wiring-slice proof for the M3 L2/L3 replay gates through real composition:
 * a host registers a real `SdkReplayRunner` (over a scripted delegate) via
 * `setReplayRunner`, a steered session finalizes, and the L2 pair runs
 * through the registered runner — candidate arm mounted, baseline bare —
 * with both runs ledgered. Flush never blocks; the runner is the only
 * replay seam the pipeline reads.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import { SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session'
import { ToolCallId, createAssistantMessage, createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { AssistantMessage, StreamChunk } from '@deepseek-ai/dsh-llm'
import { SdkReplayRunner } from '@deepseek-ai/dsh-session-meta-replay'
import type { ReplayRunFn, ReplayRunOptions, ReplayRunResult } from '@deepseek-ai/dsh-session-meta-replay'
import * as SessionMetaPlugin from '../src/index.ts'
import { setReplayRunner, settleSessionMeta } from '../src/index.ts'
import { MetaStore } from '../src/store.ts'
import { textChunks, VALID_PROPOSAL_JSON } from './helpers.ts'

const SURFACE = { surfaceOp: 'append' } as const

function assistantText(text: string): AssistantMessage {
  return createAssistantMessage({
    content: [{ type: 'text', text }],
    source: { provider: 'test', model: 'test' },
  })
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

/** Scripted delegate serving one completed interval and recording calls. */
class ScriptedDelegate implements ReplayRunFn {
  /** Every recorded call in order. */
  readonly calls: Array<{ input: string; options: ReplayRunOptions | undefined }> = []

  /**
   * Record the call and serve the canned completed interval.
   *
   * @param input - prompt text to record.
   * @param options - run options to record.
   * @returns the canned completed interval.
   */
  run(input: string, options?: ReplayRunOptions): Promise<ReplayRunResult> {
    this.calls.push({ input, options })
    return Promise.resolve({ events: [completedEnd()], finalResponse: 'replay ran clean' })
  }
}

/** Fake `llm` service: valid proposal, then two candidate-preferring judge verdicts. */
function judgePassLlmPlugin(chunks: ReadonlyArray<readonly StreamChunk[]>) {
  let calls = 0
  return (ctx: Context): void => {
    ctx.provide('llm', {
      async *stream(): AsyncIterable<StreamChunk> {
        const run = chunks[calls] ?? []
        calls += 1
        yield* run
      },
    })
  }
}

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  setReplayRunner(undefined)
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

/** Steered session with an opening task (L2 input) and enough tool work for the effort gate. */
function appendTaskedSteered(loaded: Context, id: string) {
  const session = loaded.sessions.create(SessionId(id))
  session.append(
    'user/message',
    createUserMessage({ content: [{ type: 'text', text: 'Confirm the destructive path before running it' }], source: { kind: 'user' } }),
    SURFACE,
  )
  session.append('assistant/message', { turn: 1, step: 1, message: assistantText('first try') }, SURFACE)
  for (let step = 1; step <= 3; step += 1) {
    const callId = ToolCallId(`read-${step}`)
    session.append('tool/call', { turn: 1, step, callId, name: 'read', arguments: '{"path":"/tmp/f"}' })
    session.append(
      'tool/result',
      {
        turn: 1,
        step,
        message: createToolResultMessage({ callId, content: [{ type: 'text', text: 'ok' }], isError: false }),
      },
      SURFACE,
    )
  }
  session.append(
    'user/message',
    createUserMessage({ content: [{ type: 'text', text: 'no, confirm first' }], source: { kind: 'user' } }),
    SURFACE,
  )
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  return session
}

describe('replay runner wiring', () => {
  it('runs the L2 pair through the registered runner and ledgers both runs', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-replay-wired-'))
    if (root === undefined) throw new Error('tmp root missing')
    const home: string = root
    const delegate = new ScriptedDelegate()
    setReplayRunner(new SdkReplayRunner(delegate))
    context = new Context()
    await context.plugin(SessionStore)
    await context.plugin(
      judgePassLlmPlugin([
        textChunks(VALID_PROPOSAL_JSON, { inputTokens: 5, outputTokens: 6 }),
        textChunks(JSON.stringify({ verdict: 'prefer-a', grounds: 'Candidate retried `path` and the result shows ok' })),
        textChunks(JSON.stringify({ verdict: 'prefer-b', grounds: 'Candidate retried `path` and the result shows ok' })),
      ]),
    )
    await context.plugin(SessionMetaPlugin, {
      dshHome: home,
      evaluator: { enabled: true, provider: 'flash', model: 'flash-1' },
    })
    await context.sessions.flush(appendTaskedSteered(context, 'wired'))
    await settleSessionMeta()

    // Candidate arm carries the draft overlay, baseline omits the key.
    expect(delegate.calls).toHaveLength(2)
    const candidateOptions = delegate.calls[0]?.options
    expect(typeof candidateOptions?.skillOverlay).toBe('string')
    const baselineOptions = delegate.calls[1]?.options
    expect(baselineOptions !== undefined && 'skillOverlay' in baselineOptions).toBe(false)

    const store = new MetaStore({ dbPath: join(home, 'meta', 'meta.db') })
    try {
      expect(store.countReplayRunsSince(0)).toBe(2)
      expect(store.countEvaluationsSince(0)).toBe(1)
    } finally {
      store.close()
    }

    // Promotion flipped the draft live: the gate flag is gone.
    const draft = readFileSync(join(home, 'skills', 'destructive-path-confirm', 'SKILL.md'), 'utf8')
    expect(draft).not.toContain('disable-model-invocation')
  })
})
