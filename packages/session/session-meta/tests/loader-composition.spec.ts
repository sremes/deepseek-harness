/**
 * Behavior proof for session-meta, following the telemetry suite's own
 * pattern: direct `ctx.plugin` composition with source imports for the event
 * flow, plus a Loader boot check proving the shipped YAML shape loads with a
 * clean namespace (no default export).
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readdirSync, writeFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ToolCallId, createAssistantMessage, createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { AssistantMessage } from '@deepseek-ai/dsh-llm'
import * as SessionMetaPlugin from '../src/index.ts'
import { MetaStore } from '../src/store.ts'
import { settleSessionMeta } from '../src/index.ts'

const SURFACE = { surfaceOp: 'append' } as const

/** Fake credential built dynamically: realistic enough for the `sk-` pattern, never a literal secret. */
const FAKE_SECRET = ['sk-', 'abc123XYZ4567'].join('')

function assistantText(text: string): AssistantMessage {
  return createAssistantMessage({
    content: [{ type: 'text', text }],
    source: { provider: 'test', model: 'test' },
  })
}

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

async function setup(dshHome: string): Promise<Context> {
  context = new Context()
  await context.plugin(SessionStore)
  await context.plugin(SessionMetaPlugin, { dshHome, maxEvidencePerSession: 3 })
  return context
}

describe('session-meta event flow', () => {
  it('folds sessions into meta.db with routes and scrubbed evidence', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-session-meta-'))
    if (root === undefined) throw new Error('loader root missing')
    const home: string = root
    const loaded = await setup(home)

    // Clean session: task, one assistant step, completed turn -> no_op.
    const clean = loaded.sessions.create(SessionId('clean'), { meta: { cwd: home } })
    clean.append(
      'user/message',
      createUserMessage({ content: [{ type: 'text', text: 'do the thing' }], source: { kind: 'user' } }),
      SURFACE,
    )
    clean.append('turn/start', { turn: 1 })
    clean.append('assistant/message', { turn: 1, step: 1, message: assistantText('done') }, SURFACE)
    clean.append('tool/call', { turn: 1, step: 1, callId: ToolCallId('c1'), name: 'read', arguments: '{}' })
    clean.append(
      'tool/result',
      {
        turn: 1,
        step: 1,
        message: createToolResultMessage({
          callId: ToolCallId('c1'),
          content: [{ type: 'text', text: 'ok' }],
          isError: false,
        }),
      },
      SURFACE,
    )
    clean.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    clean.append('feedback/record', { text: 'looks right' })
    await loaded.sessions.flush(clean)

    // Steered session: human correction after the assistant spoke -> track_a.
    const steered = loaded.sessions.create(SessionId('steered'))
    steered.append('turn/start', { turn: 1 })
    steered.append('assistant/message', { turn: 1, step: 1, message: assistantText('first try') }, SURFACE)
    steered.append(
      'user/message',
      createUserMessage({
        content: [{ type: 'text', text: `no, use the other API key ${FAKE_SECRET}` }],
        source: { kind: 'user' },
      }),
      SURFACE,
    )
    steered.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    await loaded.sessions.flush(steered)

    // Broken session: structural tool errors -> track_b with capped evidence.
    // Forged as a child of the clean session to pin lineage capture.
    const broken = loaded.sessions.create(SessionId('broken'), { meta: { parentSession: SessionId('clean') } })
    broken.append('turn/start', { turn: 1 })
    broken.append('tool/call', { turn: 1, step: 1, callId: ToolCallId('c2'), name: 'write', arguments: '{}' })
    for (let step = 1; step <= 5; step += 1) {
      broken.append(
        'tool/result',
        {
          turn: 1,
          step,
          message: createToolResultMessage({
            callId: ToolCallId('c2'),
            content: [{ type: 'text', text: 'bad' }],
            isError: true,
          }),
          error: { name: 'SyntaxError', code: 'E_PARSE' },
        },
        SURFACE,
      )
    }
    broken.append('turn/end', { turn: 1, reason: { kind: 'blocked' } })
    // Agent-level failure lands on the owning session.
    loaded.emit('agent/error', {
      agent: { session: broken } as unknown as Agent,
      turn: 1,
      step: 6,
      error: new Error('provider blew up'),
    })
    await loaded.sessions.flush(broken)

    // Interrupted session: disposed mid-turn with no turn/end -> null reason.
    const cut = loaded.sessions.create(SessionId('cut'))
    cut.append('turn/start', { turn: 1 })

    await context?.fiber.dispose()
    context = undefined

    const store = new MetaStore({ dbPath: join(home, 'meta', 'meta.db') })
    try {
      expect(store.readSession('clean')?.route).toBe('no_op')
      const steeredRow = store.readSession('steered')
      expect(steeredRow?.route).toBe('track_a')
      expect(steeredRow?.steeringEvents).toBe(1)
      const brokenRow = store.readSession('broken')
      expect(brokenRow?.route).toBe('track_b')
      expect(JSON.parse(brokenRow?.toolErrors as string)).toEqual(['SyntaxError'])
      expect(JSON.parse(brokenRow?.agentErrors as string)).toEqual(['Error'])
      expect(store.countEvidence('broken')).toBe(3)
      expect(brokenRow?.droppedEvidence).toBe(3)
      expect(store.routeHistogram()).toEqual({ track_a: 1, track_b: 1, no_op: 2 })
      expect(store.readSession('cut')?.turnEndReason).toBeNull()
      expect(store.readSession('missing')).toBeUndefined()
      expect(store.readSession('broken')?.parentSession).toBe('clean')
      // Secrets never reach the database, in rows or evidence.
      const dump = JSON.stringify(store.readSession('steered'))
      expect(dump).not.toContain(FAKE_SECRET)
    } finally {
      store.close()
    }
  })
})

describe('Track B live wire', () => {
  it('emits a runnable spec from a finalized parser crash and ledgers its run', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-session-meta-trackb-'))
    if (root === undefined) throw new Error('tmp root missing')
    const home: string = root
    const loaded = await setup(home)
    const crashed = loaded.sessions.create(SessionId('crashed'))
    crashed.append('turn/start', { turn: 1 })
    crashed.append('tool/call', { turn: 1, step: 1, callId: ToolCallId('k1'), name: 'read', arguments: '{"a":}' })
    crashed.append(
      'tool/result',
      {
        turn: 1,
        step: 1,
        message: createToolResultMessage({ callId: ToolCallId('k1'), content: [{ type: 'text', text: 'bad' }], isError: true }),
        error: { name: 'SyntaxError', code: 'E_PARSE' },
      },
      SURFACE,
    )
    crashed.append('turn/end', { turn: 1, reason: { kind: 'blocked' } })
    await loaded.sessions.flush(crashed)
    await settleSessionMeta()

    const reproDir = join(home, '.dsh', 'reproductions')
    const specs = readdirSync(reproDir).filter(file => file.endsWith('.spec.ts'))
    expect(specs).toHaveLength(1)
    const store = new MetaStore({ dbPath: join(home, 'meta', 'meta.db') })
    try {
      const rows = store.listTrackBRuns(join(reproDir, specs[0] as string))
      expect(rows).toHaveLength(1)
      expect(rows[0]?.exitCode).toBe(0)
    } finally {
      store.close()
    }
  }, 180_000)
})

describe('real Loader composition', () => {
  it('loads the shipped YAML shape with a clean namespace', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-session-meta-loader-'))
    const configPath = join(root, 'cordis.yml')
    writeFileSync(configPath, [
      '- name: \'@deepseek-ai/dsh-session\'',
      '- name: \'@deepseek-ai/dsh-session-meta\'',
      '  config:',
      `    dshHome: '${root}'`,
      '',
    ].join('\n'))

    context = new Context()
    context.baseUrl = `${pathToFileURL(root).href}/`
    await context.plugin(Loader)
    context.loader.builtins.include = Include
    const modules = new Map<string, unknown>([
      ['@deepseek-ai/dsh-session', SessionStore],
      ['@deepseek-ai/dsh-session-meta', SessionMetaPlugin],
    ])
    context.loader.internal = {
      version: 'v2',
      async import(specifier: string) {
        if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
        return modules.get(specifier)
      },
    } as unknown as NonNullable<typeof context.loader.internal>
    await context.loader.create({
      name: 'cordis:include',
      config: { path: pathToFileURL(configPath).href },
    })
    await context.loader.await()

    const unloaded = [...context.loader.entries()]
      .filter(entry => entry.fiber === undefined && !entry.disabled)
      .map(entry => entry.options.name)
    expect(unloaded).toEqual([])
  })

  it('keeps the function-plugin namespace free of a default export', () => {
    expect('default' in SessionMetaPlugin).toBe(false)
  })
})

describe('MetaStore paths', () => {
  it('supports an explicit dbPath with the default evidence bound', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-session-meta-mem-'))
    if (root === undefined) throw new Error('loader root missing')
    const home: string = root
    // Explicit file path, default evidence bound (covers both config fallbacks).
    const dbPath = join(home, 'explicit.db')
    context = new Context()
    await context.plugin(SessionStore)
    await context.plugin(SessionMetaPlugin, { dshHome: home, dbPath })
    const session = context.sessions.create(SessionId('mem'))
    session.append('turn/start', { turn: 1 })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    await context.sessions.flush(session)
    await context?.fiber.dispose()
    context = undefined
    const store = new MetaStore({ dbPath })
    try {
      expect(store.readSession('mem')?.route).toBe('no_op')
    } finally {
      store.close()
    }
  })

  it('rejects an unknown on-disk schema version instead of migrating', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-session-meta-ver-'))
    if (root === undefined) throw new Error('loader root missing')
    const dbPath = join(root, 'meta.db')
    const store = new MetaStore({ dbPath })
    store.close()
    const raw = new DatabaseSync(dbPath)
    raw.exec('PRAGMA user_version = 99')
    raw.close()
    expect(() => new MetaStore({ dbPath })).toThrow(/unsupported meta\.db schema v99/)
  })

  it('rolls back the whole session write when evidence insert fails', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-session-meta-rb-'))
    if (root === undefined) throw new Error('loader root missing')
    const dbPath = join(root, 'meta.db')
    const store = new MetaStore({ dbPath })
    try {
      const broken = {
        id: 'rb',
        cwd: null,
        parentSession: null,
        origin: null,
        startedAt: 0,
        endedAt: 1,
        events: 2,
        toolCalls: 0,
        toolErrors: [],
        agentErrors: [],
        steeringEvents: 0,
        feedbackEvents: 0,
        assistantMessages: 0,
        turnEndReason: null,
        route: 'no_op' as const,
        reasons: [],
        droppedEvidence: 0,
        evidence: [
          { seq: 1, type: 'tool/result', severity: 'error', body: '{}' },
          { seq: 1, type: 'tool/result', severity: 'error', body: '{}' },
        ],
      }
      expect(() => {
        store.writeSession(broken)
      }).toThrow()
      expect(store.readSession('rb')).toBeUndefined()
    } finally {
      store.close()
    }
  })

  it('round-trips a session in :memory: without touching the filesystem', () => {
    const store = new MetaStore({ dbPath: ':memory:' })
    try {
      const session = {
        id: 'mem',
        cwd: null,
        parentSession: null,
        origin: null,
        startedAt: 0,
        endedAt: 1,
        events: 1,
        toolCalls: 0,
        toolErrors: [],
        agentErrors: [],
        steeringEvents: 0,
        feedbackEvents: 0,
        assistantMessages: 0,
        turnEndReason: null,
        route: 'no_op' as const,
        reasons: [],
        droppedEvidence: 0,
        evidence: [],
      }
      store.writeSession(session)
      expect(store.readSession('mem')?.route).toBe('no_op')
      expect(store.routeHistogram()).toEqual({ track_a: 0, track_b: 0, no_op: 1 })
    } finally {
      store.close()
    }
  })
})
