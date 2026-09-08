/**
 * Unit proof for the M4 Track B reproduction emitter plus the M4 spec
 * runner: parser-class crashes emit deterministic specs, everything else
 * lands in the breakages register, and clean sessions leave no trace. The
 * runner slice executes emitted specs under the real Vitest binary and
 * ledgers the outcome; finalize wiring (track_b → `recordTrackB` →
 * `startReproRun` on the shared settle set) fires through the composition
 * suite, which now really spawns a repro run.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import type { SessionAggregate } from '../src/types.ts'
import { PARSER_CLASS_RE, TRACKB_RUN_TIMEOUT_MS, appendBreakage, emitReproduction, recordTrackB, resolveVitestBin, runReproduction, startReproRun } from '../src/trackb.ts'
import { MetaStore } from '../src/store.ts'
import { makeAggregate } from './helpers.ts'

const NOW = 1788297600000

/** Aggregate whose first failing step is a parser-class crash with a payload. */
function crashAggregate(sessionId: string): SessionAggregate {
  const aggregate = makeAggregate(sessionId)
  aggregate.toolCalls = 2
  aggregate.toolSteps.push({ tool: 'read', ok: true, args: '{"path":"/tmp/f"}' })
  aggregate.toolSteps.push({ tool: 'Write File!', ok: false, error: 'SyntaxError', args: '{"a":}', resultDigest: 'unexpected token' })
  aggregate.toolErrors.push('SyntaxError')
  return aggregate
}

let root: string | undefined

afterEach(async () => {
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

async function freshDir(): Promise<string> {
  root = await mkdtemp(join(tmpdir(), 'dsh-trackb-'))
  if (root === undefined) throw new Error('tmp root missing')
  const home: string = root
  // Nested on purpose: emission must create the directory recursively.
  return join(home, 'nested', 'reproductions')
}

describe('PARSER_CLASS_RE', () => {
  it.each(['SyntaxError', 'JSONParseError', 'ZodError', 'ERR_TOOL_SCHEMA_VIOLATION'])('matches parser-class %s', (name) => {
    expect(PARSER_CLASS_RE.test(name)).toBe(true)
  })

  it.each(['ERR_REGEX_TIMEOUT', 'tool-error', 'agent-error', 'Error'])('rejects non-parser %s', (name) => {
    expect(PARSER_CLASS_RE.test(name)).toBe(false)
  })
})

describe('emitReproduction', () => {
  it('emits a deterministic spec pinning session, tool, payload, and the crash assertion', async () => {
    const reproDir = await freshDir()
    const emitted = emitReproduction(crashAggregate('s1'), reproDir, NOW)
    expect(emitted?.file).toBe(join(reproDir, 'repro-s1-write-file.spec.ts'))
    const text = readFileSync(emitted?.file as string, 'utf8')
    expect(text).toContain('s1')
    expect(text).toContain('Write File!')
    expect(text).toContain(JSON.stringify('{"a":}'))
    expect(text).toContain('toThrow(SyntaxError)')
    expect(text).toContain("from 'vitest'")
    expect(text).toContain(new Date(NOW).toISOString())
    expect(text).toContain(process.version)
    expect(text).toContain(process.platform)
    expect(text).toContain(emitted?.testName as string)
  })

  it('is stable across re-emits, suffixing past occupied names without touching them', async () => {
    const reproDir = await freshDir()
    const first = emitReproduction(crashAggregate('s1'), reproDir, NOW)
    const second = emitReproduction(crashAggregate('s1'), reproDir, NOW)
    expect(second?.file).toBe(join(reproDir, 'repro-s1-write-file-2.spec.ts'))
    expect(readFileSync(second?.file as string, 'utf8')).toBe(readFileSync(first?.file as string, 'utf8'))
    expect(readFileSync(first?.file as string, 'utf8')).toContain('s1')
  })

  it('suffixes past several occupied names', async () => {
    const reproDir = await freshDir()
    mkdirSync(reproDir, { recursive: true })
    writeFileSync(join(reproDir, 'repro-s1-write-file.spec.ts'), 'taken')
    writeFileSync(join(reproDir, 'repro-s1-write-file-2.spec.ts'), 'taken')
    const emitted = emitReproduction(crashAggregate('s1'), reproDir, NOW)
    expect(emitted?.file).toBe(join(reproDir, 'repro-s1-write-file-3.spec.ts'))
    expect(readFileSync(join(reproDir, 'repro-s1-write-file.spec.ts'), 'utf8')).toBe('taken')
  })

  it('skips a structural but non-parser error', async () => {
    const reproDir = await freshDir()
    const aggregate = makeAggregate('s2')
    aggregate.toolSteps.push({ tool: 'search', ok: false, error: 'ERR_REGEX_TIMEOUT', args: '(a+)+$' })
    expect(emitReproduction(aggregate, reproDir, NOW)).toBeUndefined()
    expect(existsSync(join(reproDir, 'repro-s2-search.spec.ts'))).toBe(false)
  })

  it('skips failing steps without an error name', async () => {
    const reproDir = await freshDir()
    const aggregate = makeAggregate('s3')
    aggregate.toolSteps.push({ tool: 'read', ok: false })
    expect(emitReproduction(aggregate, reproDir, NOW)).toBeUndefined()
  })

  it('skips parser-class failures with missing or empty args', async () => {
    const reproDir = await freshDir()
    const missing = makeAggregate('s4')
    missing.toolSteps.push({ tool: 'edit', ok: false, error: 'ZodError' })
    expect(emitReproduction(missing, reproDir, NOW)).toBeUndefined()
    const empty = makeAggregate('s5')
    empty.toolSteps.push({ tool: 'edit', ok: false, error: 'ZodError', args: '' })
    expect(emitReproduction(empty, reproDir, NOW)).toBeUndefined()
    expect(existsSync(reproDir)).toBe(false)
  })

  it('yields undefined with no file for a clean aggregate', async () => {
    const reproDir = await freshDir()
    expect(emitReproduction(makeAggregate('clean'), reproDir, NOW)).toBeUndefined()
    expect(existsSync(reproDir)).toBe(false)
  })
})

describe('appendBreakage', () => {
  it('appends one register line naming the first failing step', async () => {
    const reproDir = await freshDir()
    const aggregate = makeAggregate('s6')
    aggregate.toolSteps.push({ tool: 'search', ok: false, error: 'ERR_REGEX_TIMEOUT', args: '(a+)+$', resultDigest: 'catastrophic backtracking' })
    appendBreakage(aggregate, reproDir, NOW)
    const lines = readFileSync(join(reproDir, 'breakages.jsonl'), 'utf8').trim().split('\n')
    expect(lines).toHaveLength(1)
    expect(JSON.parse(lines[0] as string)).toEqual({
      ts: NOW,
      sessionId: 's6',
      tool: 'search',
      error: 'ERR_REGEX_TIMEOUT',
      digest: 'catastrophic backtracking',
    })
  })

  it('nulls error and digest when the failing step carries neither', async () => {
    const reproDir = await freshDir()
    const aggregate = makeAggregate('s7')
    aggregate.toolSteps.push({ tool: 'read', ok: false })
    appendBreakage(aggregate, reproDir, NOW)
    expect(JSON.parse(readFileSync(join(reproDir, 'breakages.jsonl'), 'utf8'))).toEqual({
      ts: NOW,
      sessionId: 's7',
      tool: 'read',
      error: null,
      digest: null,
    })
  })

  it('nulls every step field when nothing failed', async () => {
    const reproDir = await freshDir()
    appendBreakage(makeAggregate('s8'), reproDir, NOW)
    expect(JSON.parse(readFileSync(join(reproDir, 'breakages.jsonl'), 'utf8'))).toEqual({
      ts: NOW,
      sessionId: 's8',
      tool: null,
      error: null,
      digest: null,
    })
  })
})

describe('recordTrackB', () => {
  it('emits the spec and logs the file for parser-class crashes', async () => {
    const reproDir = await freshDir()
    const logs: string[] = []
    const emitted = recordTrackB(crashAggregate('s9'), reproDir, NOW, (message) => {
      logs.push(message)
    })
    expect(emitted?.file).toBe(join(reproDir, 'repro-s9-write-file.spec.ts'))
    expect(logs).toHaveLength(1)
    expect(logs[0]).toContain('repro-s9-write-file.spec.ts')
    expect(existsSync(join(reproDir, 'breakages.jsonl'))).toBe(false)
  })

  it('registers the breakage and logs the skip with nothing emittable', async () => {
    const reproDir = await freshDir()
    const aggregate = makeAggregate('s10')
    aggregate.toolSteps.push({ tool: 'search', ok: false, error: 'ERR_REGEX_TIMEOUT', args: '(a+)+$' })
    const logs: string[] = []
    const emitted = recordTrackB(aggregate, reproDir, NOW, (message) => {
      logs.push(message)
    })
    expect(emitted).toBeUndefined()
    expect(logs).toHaveLength(1)
    expect(logs[0]).toContain('s10')
    expect(JSON.parse(readFileSync(join(reproDir, 'breakages.jsonl'), 'utf8'))).toMatchObject({ sessionId: 's10', tool: 'search' })
  })
})

describe('TRACKB_RUN_TIMEOUT_MS', () => {
  it('pins the 60s protocol kill bound', () => {
    expect(TRACKB_RUN_TIMEOUT_MS).toBe(60_000)
  })
})

describe('resolveVitestBin', () => {
  it('finds node_modules/.bin/vitest in an ancestor, preferring the nearest', async () => {
    const reproDir = await freshDir()
    const base: string = dirname(dirname(reproDir))
    const outerBinDir = join(base, 'node_modules', '.bin')
    mkdirSync(outerBinDir, { recursive: true })
    const outerBin = join(outerBinDir, 'vitest')
    writeFileSync(outerBin, 'outer')
    const startDir = join(base, 'nested')
    expect(resolveVitestBin(startDir)).toBe(outerBin)
    const innerBinDir = join(startDir, 'node_modules', '.bin')
    mkdirSync(innerBinDir, { recursive: true })
    const innerBin = join(innerBinDir, 'vitest')
    writeFileSync(innerBin, 'inner')
    expect(resolveVitestBin(startDir)).toBe(innerBin)
  })

  it('returns undefined when no level holds the binary', async () => {
    const reproDir = await freshDir()
    expect(resolveVitestBin(join(dirname(dirname(reproDir)), 'nested'))).toBeUndefined()
  })

  it('ignores a node_modules/.bin/vitest that is a directory, not a file', async () => {
    const reproDir = await freshDir()
    const base: string = dirname(dirname(reproDir))
    mkdirSync(join(base, 'node_modules', '.bin', 'vitest'), { recursive: true })
    expect(resolveVitestBin(join(base, 'nested'))).toBeUndefined()
  })

  it('climbs at most 6 levels', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-trackb-bin-'))
    const base: string = root
    const binDir = join(base, 'node_modules', '.bin')
    mkdirSync(binDir, { recursive: true })
    const bin = join(binDir, 'vitest')
    writeFileSync(bin, 'fake')
    const deep6 = join(base, 'd1', 'd2', 'd3', 'd4', 'd5', 'd6')
    mkdirSync(deep6, { recursive: true })
    // startDir plus 5 ancestors never reach the binary at the 7th level.
    expect(resolveVitestBin(deep6)).toBeUndefined()
    // One level up, the binary sits exactly at the 6th level.
    expect(resolveVitestBin(join(base, 'd1', 'd2', 'd3', 'd4', 'd5'))).toBe(bin)
  })
})

describe('runReproduction', () => {
  it('ledgers -1 plus one log line when the binary cannot spawn', async () => {
    const store = new MetaStore({ dbPath: ':memory:' })
    try {
      const logs: string[] = []
      const file = join('nowhere', 'repro.spec.ts')
      await runReproduction({ file, vitestBin: join('nowhere', 'vitest'), timeoutMs: 1000, store, now: NOW, log: message => logs.push(message) })
      expect(store.listTrackBRuns(file)).toEqual([{ ts: NOW, file, exitCode: -1 }])
      expect(logs).toHaveLength(1)
      expect(logs[0]).toContain(file)
      expect(logs[0]).toContain('exited -1')
    } finally {
      store.close()
    }
  })

  it('ledgers -1 when spawn throws synchronously (NUL in argv)', async () => {
    const store = new MetaStore({ dbPath: ':memory:' })
    try {
      const logs: string[] = []
      const file = join(tmpdir(), 'bad\0file.spec.ts')
      await runReproduction({ file, vitestBin: 'vitest', timeoutMs: 1000, store, now: NOW, log: message => logs.push(message) })
      expect(store.listTrackBRuns(file)).toEqual([{ ts: NOW, file, exitCode: -1 }])
      expect(logs).toHaveLength(1)
    } finally {
      store.close()
    }
  })

  it('still logs when the ledger insert fails on a closed store', async () => {
    const store = new MetaStore({ dbPath: ':memory:' })
    store.close()
    const logs: string[] = []
    const file = join(await freshDir(), 'repro.spec.ts')
    await runReproduction({ file, vitestBin: join('nowhere', 'vitest'), timeoutMs: 1000, store, now: NOW, log: message => logs.push(message) })
    expect(logs).toHaveLength(1)
    expect(logs[0]).toContain('exited -1')
  })
})

describe('startReproRun', () => {
  it('resolves without logging or ledgering on the breakage path (no emitted spec)', async () => {
    const store = new MetaStore({ dbPath: ':memory:' })
    try {
      const logs: string[] = []
      await expect(
        startReproRun({
          emitted: undefined,
          startDir: tmpdir(),
          timeoutMs: 1000,
          store,
          now: NOW,
          log: message => logs.push(message),
        }),
      ).resolves.toBeUndefined()
      expect(logs).toEqual([])
      expect(store.listTrackBRuns('anything')).toEqual([])
    } finally {
      store.close()
    }
  })

  it('logs the skip and ledgers nothing when no binary resolves', async () => {
    const reproDir = await freshDir()
    const store = new MetaStore({ dbPath: ':memory:' })
    try {
      const logs: string[] = []
      await startReproRun({
        emitted: { file: join(reproDir, 'repro.spec.ts'), testName: 'repro' },
        startDir: join(dirname(dirname(reproDir)), 'nested'),
        timeoutMs: 1000,
        store,
        now: NOW,
        log: message => logs.push(message),
      })
      expect(logs).toEqual(['session-meta: track_b runner skipped (no vitest binary)'])
      expect(store.listTrackBRuns(join(reproDir, 'repro.spec.ts'))).toEqual([])
    } finally {
      store.close()
    }
  })

  it('runs the spec and ledgers the outcome when a binary resolves', async () => {
    const reproDir = await freshDir()
    const base: string = dirname(dirname(reproDir))
    const binDir = join(base, 'node_modules', '.bin')
    mkdirSync(binDir, { recursive: true })
    // Present but not executable: the spawn fails fast and ledgers -1.
    writeFileSync(join(binDir, 'vitest'), 'not executable')
    const store = new MetaStore({ dbPath: ':memory:' })
    try {
      const logs: string[] = []
      const file = join(reproDir, 'repro.spec.ts')
      await startReproRun({
        emitted: { file, testName: 'repro' },
        startDir: join(base, 'nested'),
        timeoutMs: 10_000,
        store,
        now: NOW,
        log: message => logs.push(message),
      })
      expect(store.listTrackBRuns(file)).toEqual([{ ts: NOW, file, exitCode: -1 }])
      expect(logs).toHaveLength(1)
      expect(logs[0]).toContain('exited -1')
    } finally {
      store.close()
    }
  })
})

/** Aggregate with one SyntaxError-labelled failing step carrying `args`. */
function payloadAggregate(sessionId: string, args: string): SessionAggregate {
  const aggregate = makeAggregate(sessionId)
  aggregate.toolCalls = 1
  aggregate.toolSteps.push({ tool: 'write', ok: false, error: 'SyntaxError', args })
  aggregate.toolErrors.push('SyntaxError')
  return aggregate
}

describe('M4 Track B spec runner acceptance (real vitest)', () => {
  // Scratch lives inside the package so the spawned run resolves the
  // `from 'vitest'` import through the workspace node_modules.
  const pkgRoot = dirname(dirname(fileURLToPath(new URL(import.meta.url))))

  function realVitestBin(): string {
    const bin = resolveVitestBin(dirname(fileURLToPath(new URL(import.meta.url))))
    expect(bin, 'M4 acceptance requires a real vitest binary (resolveVitestBin found none)').toBeDefined()
    if (bin === undefined) throw new Error('real vitest binary missing')
    return bin
  }

  async function freshRepoScratch(): Promise<string> {
    root = await mkdtemp(join(pkgRoot, '.tmp-trackb-accept-'))
    if (root === undefined) throw new Error('scratch root missing')
    return root
  }

  it('ledgers exit 0 while the crash reproduces (unparseable payload)', async () => {
    const vitestBin = realVitestBin()
    const dir = await freshRepoScratch()
    const store = new MetaStore({ dbPath: ':memory:' })
    try {
      const emitted = emitReproduction(payloadAggregate('accept-green', '{"a":}'), dir, NOW)
      if (emitted === undefined) throw new Error('emission missing for the green aggregate')
      const logs: string[] = []
      await runReproduction({ file: emitted.file, vitestBin, timeoutMs: 120_000, store, now: NOW, log: message => logs.push(message) })
      expect(store.listTrackBRuns(emitted.file)).toEqual([{ ts: NOW, file: emitted.file, exitCode: 0 }])
      expect(logs).toHaveLength(1)
      expect(logs[0]).toContain('exited 0')
    } finally {
      store.close()
    }
  }, 180_000)

  it('ledgers a nonzero exit when the payload parses (valid JSON under a SyntaxError label)', async () => {
    const vitestBin = realVitestBin()
    const dir = await freshRepoScratch()
    const store = new MetaStore({ dbPath: ':memory:' })
    try {
      const emitted = emitReproduction(payloadAggregate('accept-red', '{"a":1}'), dir, NOW)
      if (emitted === undefined) throw new Error('emission missing for the red aggregate')
      const logs: string[] = []
      await runReproduction({ file: emitted.file, vitestBin, timeoutMs: 120_000, store, now: NOW, log: message => logs.push(message) })
      const rows = store.listTrackBRuns(emitted.file)
      expect(rows).toHaveLength(1)
      expect(rows[0]?.exitCode).not.toBe(0)
      expect(logs).toHaveLength(1)
    } finally {
      store.close()
    }
  }, 180_000)

  it('SIGKILLs past the timeout and ledgers -1', async () => {
    const vitestBin = realVitestBin()
    const dir = await freshRepoScratch()
    const store = new MetaStore({ dbPath: ':memory:' })
    try {
      const emitted = emitReproduction(payloadAggregate('accept-timeout', '{"a":}'), dir, NOW)
      if (emitted === undefined) throw new Error('emission missing for the timeout aggregate')
      const logs: string[] = []
      await runReproduction({ file: emitted.file, vitestBin, timeoutMs: 500, store, now: NOW, log: message => logs.push(message) })
      expect(store.listTrackBRuns(emitted.file)).toEqual([{ ts: NOW, file: emitted.file, exitCode: -1 }])
      expect(logs).toHaveLength(1)
    } finally {
      store.close()
    }
  }, 60_000)
})
