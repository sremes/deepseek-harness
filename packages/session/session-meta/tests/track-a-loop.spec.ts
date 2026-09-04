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
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
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

describe('Track A loop wiring', () => {
  it('writes a gated draft for a steered session and consumes the steering file', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-track-a-wired-'))
    if (root === undefined) throw new Error('tmp root missing')
    const home: string = root
    const loaded = await setup(home, { evaluator: { enabled: true, provider: 'flash', model: 'flash-1' } }, true)
    mkdirSync(join(home, 'meta', 'steering'), { recursive: true })
    writeFileSync(steeringFilePath(home, 'wired'), JSON.stringify({ original_task: 'do x', correction: 'confirm first' }))
    await loaded.sessions.flush(appendSteered(loaded, 'wired'))
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
})
