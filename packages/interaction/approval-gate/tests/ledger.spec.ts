/**
 * Ledger specs: command classification keeps no raw text, the ledger never
 * throws on hostile homes, and the wired plugin records every layer plus
 * the downstream outcome of delegations (the lapse signal).
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import ApprovalService from '@deepseek-ai/dsh-user-approval'
import type { ApprovalRequest } from '@deepseek-ai/dsh-user-approval'
import * as GatePlugin from '../src/index.ts'
import { DECISIONS_FILE, classifyCommand, recordDecision } from '../src/ledger.ts'

function fakeAgent(): Agent {
  const events: Array<{ type: string }> = [{ type: 'turn/start' }]
  const session: Record<string, unknown> = {
    get seq() {
      return events.length
    },
    eventAt: (seq: number) => events[seq],
    append: (type: string, data: Record<string, unknown>) => {
      events.push({ type, ...data })
      return { type, data }
    },
  }
  return { session } as unknown as Agent
}

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

async function freshHome(): Promise<string> {
  root = await mkdtemp(join(tmpdir(), 'dsh-gate-ledger-'))
  return root
}

async function ledgerLines(home: string): Promise<Array<Record<string, unknown>>> {
  const text = await readFile(join(home, 'meta', DECISIONS_FILE), 'utf8')
  return text.trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>)
}

describe('classifyCommand', () => {
  it('reduces commands to shape without raw text', () => {
    expect(classifyCommand('echo hi')).toEqual({ bin: 'echo', argc: 2, metachars: false })
    expect(classifyCommand('  git   log --oneline ')).toEqual({ bin: 'git', argc: 3, metachars: false })
    expect(classifyCommand('cat a | grep b')).toEqual({ bin: 'cat', argc: 5, metachars: true })
    expect(classifyCommand('')).toEqual({ bin: '', argc: 0, metachars: false })
  })
})

describe('recordDecision', () => {
  it('appends timestamped JSON lines', async () => {
    const home = await freshHome()
    await recordDecision(home, { layer: 'allowlist', outcome: 'allowed-once', bin: 'echo', argc: 2, metachars: false })
    const lines = await ledgerLines(home)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatchObject({ layer: 'allowlist', outcome: 'allowed-once', bin: 'echo' })
    expect(typeof lines[0]?.['ts']).toBe('number')
  })

  it('never throws on hostile homes', async () => {
    const home = await freshHome()
    const blocker = join(home, 'meta')
    await writeFile(blocker, 'a file where the directory should be')
    await expect(
      recordDecision(home, { layer: 'delegate', outcome: 'unavailable', reason: 'no-key' }),
    ).resolves.toBeUndefined()
  })
})

describe('gate decision ledger wiring', () => {
  it('records claims and delegation outcomes without raw commands', async () => {
    const home = await freshHome()
    context = new Context()
    await context.plugin(ApprovalService)
    await context.plugin(GatePlugin, { dshHome: home, judgeBackend: 'llm', apiKeyEnv: 'APPROVAL_GATE_TEST_KEY' })
    const secret = 'echo sk-secret-xyz-123'
    await context.emit('session/event', {} as never, {
      type: 'tool/call',
      data: { callId: 'c-allow', name: 'bash', arguments: JSON.stringify({ command: secret }) },
    } as never)
    const agent = fakeAgent()
    await expect(
      context.approval.request({ agent, toolName: 'bash', callId: ToolCallId('c-allow'), reason: 'need echo' } as ApprovalRequest),
    ).resolves.toBe('allowed-once')
    // No key configured: delegates, and the lone waterfall answers 'unavailable'.
    await context.emit('session/event', {} as never, {
      type: 'tool/call',
      data: { callId: 'c-nokey', name: 'bash', arguments: JSON.stringify({ command: 'vitest run x' }) },
    } as never)
    await expect(
      context.approval.request({ agent, toolName: 'bash', callId: ToolCallId('c-nokey'), reason: 'need tests' } as ApprovalRequest),
    ).resolves.toBe('unavailable')
    const lines = await ledgerLines(home)
    expect(lines.map(line => line['layer'])).toEqual(['allowlist', 'delegate'])
    expect(lines[0]).toMatchObject({ outcome: 'allowed-once', bin: 'echo' })
    expect(lines[1]).toMatchObject({ outcome: 'unavailable', reason: 'no-key' })
    const raw = await readFile(join(home, 'meta', DECISIONS_FILE), 'utf8')
    expect(raw).not.toContain('sk-secret-xyz-123')
  })
})
