/**
 * Boot-drive wiring proof: with `driveOnBoot`, the first finalized session
 * queues one post-hoc steering drive through the real plugin wiring (real
 * store, real LLM service resolution, shared settle drain). A seeded
 * aggregate + pending record for an exited session evaluates end to end;
 * without the flag the record stays pending.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import * as SessionMetaPlugin from '../src/index.ts'
import { settleSessionMeta } from '../src/index.ts'
import { MetaStore } from '../src/store.ts'
import { makeAggregate, textChunks, VALID_PROPOSAL_JSON } from './helpers.ts'

const SURFACE = { surfaceOp: 'append' } as const

/** Fake `llm` service serving the valid proposal once. */
function okLlmPlugin() {
  const chunks = textChunks(VALID_PROPOSAL_JSON, { inputTokens: 5, outputTokens: 6 })
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

/** Seed a finalized aggregate, three promotion-cap rows, and a pending record. */
function seedPending(home: string, sessionId: string): void {
  mkdirSync(join(home, 'meta'), { recursive: true })
  const seed = new MetaStore({ dbPath: join(home, 'meta', 'meta.db') })
  try {
    const aggregate = makeAggregate(sessionId)
    aggregate.toolCalls = 5
    seed.writeAggregate(sessionId, aggregate)
    seed.recordPromotion('cap-sig-1', 'cap-slug-1')
    seed.recordPromotion('cap-sig-2', 'cap-slug-2')
    seed.recordPromotion('cap-sig-3', 'cap-slug-3')
  } finally {
    seed.close()
  }
  mkdirSync(join(home, 'meta', 'steering'), { recursive: true })
  writeFileSync(
    join(home, 'meta', 'steering', `${sessionId}.json`),
    JSON.stringify({ original_task: 'Summarize the inbox', correction: 'Read every thread before summarizing' }),
  )
}

async function boot(home: string, driveOnBoot: boolean): Promise<Context> {
  const loaded = new Context()
  await loaded.plugin(SessionStore)
  await loaded.plugin(okLlmPlugin())
  const pluginConfig: Record<string, unknown> = {
    dshHome: home,
    evaluator: { enabled: true, provider: 'flash', model: 'flash-1', maxCallsPerDay: 10 },
  }
  if (driveOnBoot) pluginConfig.driveOnBoot = true
  await loaded.plugin(SessionMetaPlugin, pluginConfig)
  return loaded
}

/** One minimal live session to trigger first-finalize. */
function flushLive(loaded: Context, id: string): Promise<void> {
  const session = loaded.sessions.create(SessionId(id))
  session.append(
    'user/message',
    createUserMessage({ content: [{ type: 'text', text: 'Boot probe' }], source: { kind: 'user' } }),
    SURFACE,
  )
  return loaded.sessions.flush(session)
}

function readStore(home: string): MetaStore {
  return new MetaStore({ dbPath: join(home, 'meta', 'meta.db') })
}

describe('driveOnBoot wiring', () => {
  it('drives the pending record on first finalize and consumes it', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-boot-drive-'))
    if (root === undefined) throw new Error('tmp root missing')
    const home: string = root
    seedPending(home, 'past')
    context = await boot(home, true)
    await flushLive(context, 'now')
    await settleSessionMeta()

    const store = readStore(home)
    try {
      expect(store.countEvaluationsSince(0)).toBe(1)
      expect(store.hasEvaluation('past')).toBe(true)
    } finally {
      store.close()
    }
    expect(existsSync(join(home, 'meta', 'steering', 'past.json'))).toBe(false)
    expect(existsSync(join(home, 'meta', 'steering', 'processed', 'past.json'))).toBe(true)
    expect(existsSync(join(home, 'skills', 'destructive-path-confirm', 'SKILL.md'))).toBe(true)
  })

  it('leaves the record pending without the flag', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-boot-drive-'))
    if (root === undefined) throw new Error('tmp root missing')
    const home: string = root
    seedPending(home, 'past')
    context = await boot(home, false)
    await flushLive(context, 'now')
    await settleSessionMeta()

    const store = readStore(home)
    try {
      expect(store.countEvaluationsSince(0)).toBe(0)
    } finally {
      store.close()
    }
    expect(existsSync(join(home, 'meta', 'steering', 'past.json'))).toBe(true)
  })

  it('drives once across two finalizes', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-boot-drive-'))
    if (root === undefined) throw new Error('tmp root missing')
    const home: string = root
    seedPending(home, 'past')
    context = await boot(home, true)
    await flushLive(context, 'now-1')
    await flushLive(context, 'now-2')
    await settleSessionMeta()

    const store = readStore(home)
    try {
      expect(store.countEvaluationsSince(0)).toBe(1)
    } finally {
      store.close()
    }
  })
})
