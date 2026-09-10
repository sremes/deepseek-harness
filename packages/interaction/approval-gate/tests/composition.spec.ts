/**
 * Wiring specs for the gate plugin: the firehose feeds command recovery,
 * the waterfall answers through the real approval service (audit pair
 * included), and a Loader boot proves the shipped shape loads clean.
 * The judge never touches the network here — global fetch is stubbed.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chmodSync, mkdirSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { writeFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import ApprovalService from '@deepseek-ai/dsh-user-approval'
import type { ApprovalRequest } from '@deepseek-ai/dsh-user-approval'
import * as GatePlugin from '../src/index.ts'
import { resolveGateConfig } from '../src/index.ts'

/** Minimal agent stand-in: the service only reaches `agent.session`. */
function fakeAgent(header?: { cwd?: string }): { agent: Agent; appended: string[] } {
  const appended: string[] = []
  const events: Array<{ type: string }> = [{ type: 'turn/start' }, { type: 'user/message' }]
  const session: Record<string, unknown> = {
    get seq() {
      return events.length
    },
    eventAt: (seq: number) => events[seq],
    append: (type: string, data: Record<string, unknown>) => {
      events.push({ type, ...data })
      appended.push(type)
      return { type, data }
    },
  }
  if (header !== undefined) session['header'] = header
  return { agent: { session } as unknown as Agent, appended }
}

function requestOf(agent: Agent, overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return { agent, toolName: 'bash', ...overrides }
}

/** Stub the global fetch with one canned judge body. */
function stubJudge(body: unknown, status = 200): void {
  vi.stubGlobal(
    'fetch',
    async () => ({
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    }),
  )
}

function verdictBody(verdict: unknown, grounds: unknown): unknown {
  return { choices: [{ message: { content: JSON.stringify({ verdict, grounds }) } }] }
}

/** Announce one tool call on the firehose so the gate can recover it. */
async function announce(ctx: Context, callId: string, command: string): Promise<void> {
  await ctx.emit('session/event', {}, { type: 'tool/call', data: { callId, name: 'bash', arguments: JSON.stringify({ command }) } })
}

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  vi.unstubAllGlobals()
  delete process.env['APPROVAL_GATE_TEST_KEY']
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

async function freshHome(): Promise<string> {
  root = await mkdtemp(join(tmpdir(), 'dsh-gate-wired-'))
  if (root === undefined) throw new Error('tmp root missing')
  return root
}

async function mounted(home: string, config: Record<string, unknown> = {}): Promise<Context> {
  context = new Context()
  await context.plugin(ApprovalService)
  await context.plugin(GatePlugin, { dshHome: home, apiKeyEnv: 'APPROVAL_GATE_TEST_KEY', ...config })
  return context
}

describe('resolveGateConfig', () => {
  it('fails loud on an empty home or key name', () => {
    expect(() => resolveGateConfig({ dshHome: '' })).toThrow(/dshHome/)
    expect(() => resolveGateConfig({} as { dshHome: string })).toThrow(/dshHome/)
    expect(() => resolveGateConfig({ dshHome: '/h', apiKeyEnv: '' })).toThrow(/apiKeyEnv/)
  })

  it('resolves documented defaults', () => {
    expect(resolveGateConfig({ dshHome: '/h' })).toMatchObject({
      judgeUrl: 'https://api.deepinfra.com/v1/openai',
      judgeModel: 'deepseek-ai/DeepSeek-V4-Flash-0731',
      apiKeyEnv: 'DEEPINFRA_API_KEY',
      timeoutMs: 45000,
      maxCallsPerDay: 50,
    })
  })
})

describe('gate plugin wiring', () => {
  it('allows allowlisted commands and audits the pair', async () => {
    const home = await freshHome()
    const loaded = await mounted(home)
    await announce(loaded, 'c-allow', 'echo hi')
    const { agent, appended } = fakeAgent({ cwd: '/w' })
    const outcome = await loaded.approval.request(requestOf(agent, { callId: ToolCallId('c-allow'), reason: 'need echo' }))
    expect(outcome).toBe('allowed-once')
    expect(appended).toEqual(['approval/asked', 'approval/decided'])
  })

  it('rejects blacklisted commands', async () => {
    const home = await freshHome()
    const loaded = await mounted(home)
    await announce(loaded, 'c-deny', 'rm -rf /')
    const { agent } = fakeAgent()
    const outcome = await loaded.approval.request(requestOf(agent, { callId: ToolCallId('c-deny'), reason: 'need rm' }))
    expect(outcome).toBe('rejected')
  })

  it('delegates non-bash tools and unrecoverable commands', async () => {
    const home = await freshHome()
    const loaded = await mounted(home)
    const { agent } = fakeAgent()
    await expect(loaded.approval.request(requestOf(agent, { toolName: 'write' }))).resolves.toBe('unavailable')
    await expect(loaded.approval.request(requestOf(agent, { callId: ToolCallId('ghost'), reason: 'x' }))).resolves.toBe(
      'unavailable',
    )
    await expect(loaded.approval.request(requestOf(agent, {}))).resolves.toBe('unavailable')
    const numeric = { agent, toolName: 'bash', callId: 7 } as unknown as ApprovalRequest
    await expect(loaded.approval.request(numeric)).resolves.toBe('unavailable')
  })

  it('ignores firehose shapes that carry no call identity', async () => {
    const home = await freshHome()
    const loaded = await mounted(home)
    await loaded.emit('session/event', {}, { type: 'user/message', data: {} })
    await loaded.emit('session/event', {}, { type: 'tool/call', data: 'not-an-object' })
    await loaded.emit('session/event', {}, { type: 'tool/call', data: {} })
    await loaded.emit('session/event', {}, { type: 'tool/call', data: { callId: 7, name: 'bash' } })
    await loaded.emit('session/event', {}, { type: 'tool/call', data: { callId: '', name: 'bash' } })
    await announce(loaded, 'c-kept', 'echo hi')
    const { agent } = fakeAgent()
    await expect(
      loaded.approval.request(requestOf(agent, { callId: ToolCallId('c-kept'), reason: 'need echo' })),
    ).resolves.toBe('allowed-once')
  })

  it('judges the rest through the stubbed route', async () => {
    const home = await freshHome()
    process.env['APPROVAL_GATE_TEST_KEY'] = 'test-key'
    const loaded = await mounted(home)
    await announce(loaded, 'c-ok', 'vitest run x')
    await announce(loaded, 'c-no', 'npm test')
    const { agent } = fakeAgent()
    stubJudge(verdictBody('allow', 'read-only build step'))
    await expect(
      loaded.approval.request(requestOf(agent, { callId: ToolCallId('c-ok'), reason: 'need tests' })),
    ).resolves.toBe('allowed-once')
    stubJudge(verdictBody('reject', 'unclear blast radius'))
    await expect(
      loaded.approval.request(requestOf(agent, { callId: ToolCallId('c-no'), reason: 'need check' })),
    ).resolves.toBe('rejected')
  })

  it('delegates judge faults, missing keys, and spent budgets', async () => {
    const home = await freshHome()
    const loaded = await mounted(home, { maxCallsPerDay: 1 })
    await announce(loaded, 'c-fault', 'vitest run x')
    await announce(loaded, 'c-spent', 'vitest run y')
    const { agent } = fakeAgent()
    stubJudge({}, 500)
    await expect(
      loaded.approval.request(requestOf(agent, { callId: ToolCallId('c-fault'), reason: 'need tests' })),
    ).resolves.toBe('unavailable')
    delete process.env['APPROVAL_GATE_TEST_KEY']
    await expect(
      loaded.approval.request(requestOf(agent, { callId: ToolCallId('c-fault'), reason: 'need tests' })),
    ).resolves.toBe('unavailable')
    process.env['APPROVAL_GATE_TEST_KEY'] = 'test-key'
    stubJudge(verdictBody('allow', 'fine'))
    await expect(
      loaded.approval.request(requestOf(agent, { callId: ToolCallId('c-fault'), reason: 'need tests' })),
    ).resolves.toBe('allowed-once')
    await expect(
      loaded.approval.request(requestOf(agent, { callId: ToolCallId('c-spent'), reason: 'need tests' })),
    ).resolves.toBe('unavailable')
  })

  it('contains a store failure inside the request', async () => {
    const home = await freshHome()
    process.env['APPROVAL_GATE_TEST_KEY'] = 'test-key'
    const loaded = await mounted(home)
    await announce(loaded, 'c-ro', 'vitest run x')
    mkdirSync(join(home, 'meta'), { recursive: true })
    chmodSync(join(home, 'meta'), 0o555)
    try {
      const { agent } = fakeAgent()
      await expect(
        loaded.approval.request(requestOf(agent, { callId: ToolCallId('c-ro'), reason: 'need tests' })),
      ).resolves.toBe('unavailable')
    } finally {
      chmodSync(join(home, 'meta'), 0o755)
    }
  })

  it('reads cwd when present and ignores non-string roots', async () => {
    const home = await freshHome()
    process.env['APPROVAL_GATE_TEST_KEY'] = 'test-key'
    const loaded = await mounted(home)
    await announce(loaded, 'c-cwd', 'vitest run x')
    stubJudge(verdictBody('allow', 'fine'))
    const { agent } = fakeAgent({ cwd: '/w' })
    await expect(
      loaded.approval.request(requestOf(agent, { callId: ToolCallId('c-cwd'), reason: 'need tests' })),
    ).resolves.toBe('allowed-once')
    const { agent: odd } = fakeAgent({ cwd: 42 as unknown as string })
    await expect(
      loaded.approval.request(requestOf(odd, { callId: ToolCallId('c-cwd'), reason: 'need tests' })),
    ).resolves.toBe('allowed-once')
  })

  it('degrades an unmarked reason with a failing judge', async () => {
    const home = await freshHome()
    process.env['APPROVAL_GATE_TEST_KEY'] = 'test-key'
    const loaded = await mounted(home)
    await announce(loaded, 'c-bare', 'vitest run x')
    stubJudge({}, 500)
    const { agent } = fakeAgent()
    await expect(loaded.approval.request(requestOf(agent, { callId: ToolCallId('c-bare') }))).resolves.toBe(
      'unavailable',
    )
  })

  it('drops newest calls past the observation cap', async () => {
    const home = await freshHome()
    const loaded = await mounted(home)
    for (let n = 0; n < 501; n += 1) {
      await announce(loaded, `cap-${String(n)}`, 'echo hi')
    }
    const { agent } = fakeAgent()
    await expect(
      loaded.approval.request(requestOf(agent, { callId: ToolCallId('cap-0'), reason: 'need echo' })),
    ).resolves.toBe('allowed-once')
    await expect(
      loaded.approval.request(requestOf(agent, { callId: ToolCallId('cap-500'), reason: 'need echo' })),
    ).resolves.toBe('unavailable')
  })
})

describe('real Loader composition', () => {
  it('loads the shipped shape with a clean namespace', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-gate-loader-'))
    if (root === undefined) throw new Error('loader root missing')
    const configPath = join(root, 'cordis.yml')
    writeFileSync(configPath, ['- name: \'@deepseek-ai/dsh-approval-gate\'', '  config:', `    dshHome: '${root}'`, ''].join('\n'))
    context = new Context()
    context.baseUrl = `${pathToFileURL(root).href}/`
    await context.plugin(Loader)
    context.loader.builtins.include = Include
    const modules = new Map<string, unknown>([['@deepseek-ai/dsh-approval-gate', GatePlugin]])
    context.loader.internal = {
      version: 'v2',
      async import(specifier: string) {
        if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
        return modules.get(specifier)
      },
    } as unknown as NonNullable<typeof context.loader.internal>
    await context.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
    await context.loader.await()
    const unloaded = [...context.loader.entries()]
      .filter(entry => entry.fiber === undefined && !entry.disabled)
      .map(entry => entry.options.name)
    expect(unloaded).toEqual([])
  })

  it('keeps the function-plugin namespace free of a default export', () => {
    expect('default' in GatePlugin).toBe(false)
  })
})
