/**
 * End-to-end proof for the M2 Track A loop through real composition:
 * a steered session finalizes, the evaluator runs off-thread, and a gated
 * draft lands on disk — while flush/dispose never block or throw.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import { ToolCallId, createAssistantMessage, createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { AssistantMessage, StreamChunk } from '@deepseek-ai/dsh-llm'
import * as SessionMetaPlugin from '../src/index.ts'
import { settleSessionMeta } from '../src/index.ts'
import { MetaStore } from '../src/store.ts'
import { steeringFilePath } from '../src/steering.ts'
import { textChunks, VALID_PROPOSAL_JSON } from './helpers.ts'

const SURFACE = { surfaceOp: 'append' } as const

function assistantText(text: string): AssistantMessage {
  return createAssistantMessage({
    content: [{ type: 'text', text }],
    source: { provider: 'test', model: 'test' },
  })
}

/** Function plugin providing a fake `llm` service from canned chunks. */
function fakeLlmPlugin(chunks: readonly StreamChunk[]) {
  return (ctx: Context): void => {
    ctx.provide('llm', {
      async *stream(): AsyncIterable<StreamChunk> {
        yield* chunks
      },
    })
  }
}

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

async function setup(home: string, config: Record<string, unknown>, withLlm: boolean): Promise<Context> {
  context = new Context()
  await context.plugin(SessionStore)
  if (withLlm) await context.plugin(fakeLlmPlugin(textChunks(VALID_PROPOSAL_JSON, { inputTokens: 5, outputTokens: 6 })))
  await context.plugin(SessionMetaPlugin, { dshHome: home, ...config })
  return context
}

function appendSteered(loaded: Context, id: string) {
  const session = loaded.sessions.create(SessionId(id))
  session.append('turn/start', { turn: 1 })
  session.append('assistant/message', { turn: 1, step: 1, message: assistantText('first try') }, SURFACE)
  session.append(
    'user/message',
    createUserMessage({ content: [{ type: 'text', text: 'no, confirm first' }], source: { kind: 'user' } }),
    SURFACE,
  )
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  return session
}

/** Steered session with enough tool work to pass the M2.2 effort gate. */
function appendSubstantial(loaded: Context, id: string) {
  const session = loaded.sessions.create(SessionId(id))
  session.append('turn/start', { turn: 1 })
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

/** Flail-then-succeed with no steering: fail once, retry, complete. */
function appendFlailThenSucceed(loaded: Context, id: string) {
  const session = loaded.sessions.create(SessionId(id))
  session.append('turn/start', { turn: 1 })
  session.append('assistant/message', { turn: 1, step: 1, message: assistantText('trying') }, SURFACE)
  session.append('tool/call', { turn: 1, step: 1, callId: ToolCallId('f1'), name: 'edit', arguments: '{"force":false}' })
  session.append(
    'tool/result',
    {
      turn: 1,
      step: 1,
      message: createToolResultMessage({ callId: ToolCallId('f1'), content: [{ type: 'text', text: 'denied' }], isError: true }),
      error: { name: 'E_TIMEOUT', code: 'E_TIMEOUT' },
    },
    SURFACE,
  )
  session.append('tool/call', { turn: 1, step: 2, callId: ToolCallId('f2'), name: 'edit', arguments: '{"force":true}' })
  session.append(
    'tool/result',
    {
      turn: 1,
      step: 2,
      message: createToolResultMessage({ callId: ToolCallId('f2'), content: [{ type: 'text', text: 'ok' }], isError: false }),
    },
    SURFACE,
  )
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  return session
}

/** Structural crash: parser error, blocked turn, no recovery. */
function appendCrash(loaded: Context, id: string) {
  const session = loaded.sessions.create(SessionId(id))
  session.append('turn/start', { turn: 1 })
  session.append('tool/call', { turn: 1, step: 1, callId: ToolCallId('b1'), name: 'write', arguments: '{}' })
  session.append(
    'tool/result',
    {
      turn: 1,
      step: 1,
      message: createToolResultMessage({ callId: ToolCallId('b1'), content: [{ type: 'text', text: 'bad' }], isError: true }),
      error: { name: 'SyntaxError', code: 'E_PARSE' },
    },
    SURFACE,
  )
  session.append('turn/end', { turn: 1, reason: { kind: 'blocked' } })
  return session
}

describe('Track A loop wiring', () => {
  it('writes a gated draft for a steered session and consumes the steering file', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-track-a-wired-'))
    if (root === undefined) throw new Error('tmp root missing')
    const home: string = root
    const loaded = await setup(home, { evaluator: { enabled: true, provider: 'flash', model: 'flash-1' } }, true)
    mkdirSync(join(home, 'meta', 'steering'), { recursive: true })
    writeFileSync(steeringFilePath(home, 'wired'), JSON.stringify({ original_task: 'do x', correction: 'confirm first' }))
    await loaded.sessions.flush(appendSubstantial(loaded, 'wired'))
    await settleSessionMeta()

    expect(existsSync(join(home, 'skills', 'destructive-path-confirm', 'SKILL.md'))).toBe(true)
    expect(existsSync(steeringFilePath(home, 'wired'))).toBe(false)
    const store = new MetaStore({ dbPath: join(home, 'meta', 'meta.db') })
    try {
      expect(store.routeHistogram()).toMatchObject({ track_a: 1 })
      expect(store.countEvaluationsSince(0)).toBe(1)
    } finally {
      store.close()
    }
  })

  it('evaluates once per session across repeated flushes', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-track-a-dedupe-'))
    if (root === undefined) throw new Error('tmp root missing')
    const home: string = root
    const loaded = await setup(
      home,
      { evaluator: { enabled: true, provider: 'flash', model: 'flash-1', maxCallsPerDay: 10 } },
      true,
    )
    const session = appendSubstantial(loaded, 'flushed')
    await loaded.sessions.flush(session)
    await loaded.sessions.flush(session)
    await loaded.sessions.flush(session)
    await settleSessionMeta()

    const store = new MetaStore({ dbPath: join(home, 'meta', 'meta.db') })
    try {
      expect(store.countEvaluationsSince(0)).toBe(1)
    } finally {
      store.close()
    }
  })

  it('provides a sessionMeta drain handle for one-shot hosts', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-track-a-handle-'))
    if (root === undefined) throw new Error('tmp root missing')
    const home: string = root
    const loaded = await setup(home, {}, false)
    const handle = loaded.get('sessionMeta') as { settle?: unknown } | undefined
    expect(typeof handle?.settle).toBe('function')
  })

  it('skips silently without an llm service', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-track-a-nollm-'))
    if (root === undefined) throw new Error('tmp root missing')
    const home: string = root
    const loaded = await setup(home, { evaluator: { enabled: true, provider: 'flash', model: 'flash-1' } }, false)
    await loaded.sessions.flush(appendSteered(loaded, 'quiet'))
    await settleSessionMeta()

    expect(existsSync(join(home, 'skills'))).toBe(false)
    const store = new MetaStore({ dbPath: join(home, 'meta', 'meta.db') })
    try {
      expect(store.countEvaluationsSince(0)).toBe(0)
    } finally {
      store.close()
    }
  })

  it('contains draft-write failures inside flush', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-track-a-contained-'))
    if (root === undefined) throw new Error('tmp root missing')
    const home: string = root
    const blocker = join(home, 'skills')
    writeFileSync(blocker, 'not a directory')
    const loaded = await setup(home, { evaluator: { enabled: true, provider: 'flash', model: 'flash-1' }, skillsDir: blocker }, true)
    await loaded.sessions.flush(appendSteered(loaded, 'blocked'))
    await settleSessionMeta()

    const store = new MetaStore({ dbPath: join(home, 'meta', 'meta.db') })
    try {
      expect(store.routeHistogram()).toMatchObject({ track_a: 1 })
    } finally {
      store.close()
    }
  })

  it('stays inert for steered sessions when the evaluator is disabled', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-track-a-off-'))
    if (root === undefined) throw new Error('tmp root missing')
    const home: string = root
    const loaded = await setup(home, {}, true)
    await loaded.sessions.flush(appendSteered(loaded, 'off'))
    await settleSessionMeta()

    expect(existsSync(join(home, 'skills'))).toBe(false)
    const store = new MetaStore({ dbPath: join(home, 'meta', 'meta.db') })
    try {
      expect(store.routeHistogram()).toMatchObject({ track_a: 1 })
      expect(store.countEvaluationsSince(0)).toBe(0)
    } finally {
      store.close()
    }
  })

  it('skips trivial steered sessions without evaluating (M2.2 effort gate)', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-track-a-trivial-'))
    if (root === undefined) throw new Error('tmp root missing')
    const home: string = root
    const loaded = await setup(home, { evaluator: { enabled: true, provider: 'flash', model: 'flash-1' } }, true)
    await loaded.sessions.flush(appendSteered(loaded, 'typo'))
    await settleSessionMeta()

    expect(existsSync(join(home, 'skills'))).toBe(false)
    const store = new MetaStore({ dbPath: join(home, 'meta', 'meta.db') })
    try {
      expect(store.routeHistogram()).toMatchObject({ track_a: 1 })
      expect(store.countEvaluationsSince(0)).toBe(0)
    } finally {
      store.close()
    }
  })

  it('mines flail-then-succeed sessions with no steering (M2.2 success path)', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-track-a-mined-'))
    if (root === undefined) throw new Error('tmp root missing')
    const home: string = root
    const loaded = await setup(home, { evaluator: { enabled: true, provider: 'flash', model: 'flash-1' } }, true)
    await loaded.sessions.flush(appendFlailThenSucceed(loaded, 'mined'))
    await settleSessionMeta()

    expect(existsSync(join(home, 'skills', 'destructive-path-confirm', 'SKILL.md'))).toBe(true)
    const store = new MetaStore({ dbPath: join(home, 'meta', 'meta.db') })
    try {
      expect(store.routeHistogram()).toMatchObject({ track_a: 1 })
      expect(store.countEvaluationsSince(0)).toBe(1)
    } finally {
      store.close()
    }
  })

  it('leaves crashed sessions to Track B without evaluating', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-track-a-crash-'))
    if (root === undefined) throw new Error('tmp root missing')
    const home: string = root
    const loaded = await setup(home, { evaluator: { enabled: true, provider: 'flash', model: 'flash-1' } }, true)
    await loaded.sessions.flush(appendCrash(loaded, 'crash'))
    await settleSessionMeta()

    expect(existsSync(join(home, 'skills'))).toBe(false)
    const store = new MetaStore({ dbPath: join(home, 'meta', 'meta.db') })
    try {
      expect(store.routeHistogram()).toMatchObject({ track_b: 1 })
      expect(store.countEvaluationsSince(0)).toBe(0)
    } finally {
      store.close()
    }
  })
})
