/**
 * M4 Track B reproduction emitter (Plan-V1 §3.5): deterministic crash
 * reports as Vitest specs under `.dsh/reproductions/`, plus the
 * known-breakages register for sessions with nothing emittable. No LLM, no
 * budget, no schema change — file emission only.
 *
 * @module @deepseek-ai/dsh-session-meta/trackb
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { SessionAggregate } from './types.ts'
import type { MetaStore } from './store.ts'
import { slugify } from './writer.ts'

/**
 * Parser-class error names (Plan-V1 §3.5 honest scope: schema/parser class
 * only). Cited to the `TRACK_B_ERROR_NAMES` structural list in `triage.ts`
 * (`SyntaxError`, `JSONParseError`, `ZodError`, `ERR_REGEX_TIMEOUT`,
 * `ERR_TOOL_SCHEMA_VIOLATION`): the syntax/parse/zod/schema/json family is
 * emittable as a runnable spec, while `ERR_REGEX_TIMEOUT` is structural but
 * not parser-class and always falls through to the breakages register.
 */
export const PARSER_CLASS_RE = /syntax|parse|zod|schema|json/i

/** Reference to one emitted reproduction spec. */
export interface TrackBReproduction {
  readonly file: string
  readonly testName: string
}

/**
 * One `breakages.jsonl` register row (the upstream-PR register for track_b
 * sessions with no emittable parser-class step).
 */
export interface TrackBBreakage {
  readonly ts: number
  readonly sessionId: string
  readonly tool: string | null
  readonly error: string | null
  readonly digest: string | null
}

/** Pure inputs for one rendered reproduction spec. */
export interface ReproductionInput {
  readonly sessionId: string
  readonly tool: string
  /** Emit-time timestamp, already ISO-formatted. */
  readonly iso: string
  /** `process.version` read at emit time (pinned text, not a live read). */
  readonly nodeVersion: string
  /** `process.platform` read at emit time (pinned text, not a live read). */
  readonly platform: string
  /** The failing tool-call arguments. */
  readonly payload: string
  readonly testName: string
}

/**
 * Render one deterministic reproduction spec. Pure: byte-exact output,
 * unit-covered.
 *
 * SEMANTICS: this is a characterization spec — it PASSES while the crash
 * reproduces and FAILS if upstream ever accepts the payload, which is the
 * invalidation signal (plan V0 Q3).
 *
 * @param input - Session/tool/payload inputs, all pinned at emit time.
 * @returns The `.spec.ts` source text.
 */
export function renderReproduction(input: ReproductionInput): string {
  return [
    `// session: ${input.sessionId} at ${input.iso} via ${input.tool}`,
    `// environment: node ${input.nodeVersion} on ${input.platform} (pinned at emit time)`,
    `import { expect, it } from 'vitest'`,
    ``,
    `// Characterization spec: passes while the crash reproduces, fails if upstream ever accepts the payload.`,
    `const payload = ${JSON.stringify(input.payload)};`,
    ``,
    `it(${JSON.stringify(input.testName)}, () => {`,
    `  expect(() => JSON.parse(payload)).toThrow(SyntaxError);`,
    `});`,
    ``,
  ].join('\n')
}

/**
 * Emit one reproduction spec for the first emittable parser-class step.
 * Creates the directory, and never overwrites: an occupied file name takes
 * the next free numeric suffix (mirrors `writeSkillDraft`).
 *
 * @param sessionId - Owning session id (part of the file name).
 * @param tool - Failing tool name (slugified into the file name).
 * @param args - Failing tool-call arguments (embedded as the payload).
 * @param reproDir - Reproduction directory (created recursively).
 * @param now - Emit-time epoch millis (ISO-formatted into the header).
 * @returns The written file and test name; never overwrites an occupant.
 */
function writeReproduction(sessionId: string, tool: string, args: string, reproDir: string, now: number): TrackBReproduction {
  const testName = `repro ${sessionId}/${tool} rejects its failing payload`
  const content = renderReproduction({
    sessionId,
    tool,
    iso: new Date(now).toISOString(),
    nodeVersion: process.version,
    platform: process.platform,
    payload: args,
    testName,
  })
  const base = `repro-${sessionId}-${slugify(tool)}`
  let file = join(reproDir, `${base}.spec.ts`)
  for (let attempt = 2; existsSync(file); attempt += 1) {
    file = join(reproDir, `${base}-${attempt}.spec.ts`)
  }
  mkdirSync(reproDir, { recursive: true })
  writeFileSync(file, content)
  return { file, testName }
}

/**
 * Emit a reproduction spec for the FIRST failing tool step (`ok === false`)
 * whose error matches {@link PARSER_CLASS_RE} and whose args is non-empty.
 *
 * @param aggregate - Finalized per-session aggregate.
 * @param reproDir - Reproduction directory (created recursively on emit).
 * @param now - Emit-time epoch millis.
 * @returns The written file and test name, or undefined when no step is
 * emittable as a runnable spec (the caller logs the skip).
 */
export function emitReproduction(
  aggregate: SessionAggregate,
  reproDir: string,
  now: number,
): TrackBReproduction | undefined {
  for (const step of aggregate.toolSteps) {
    if (step.ok) continue
    if (step.error === undefined || !PARSER_CLASS_RE.test(step.error)) continue
    if (step.args === undefined || step.args === '') continue
    return writeReproduction(aggregate.sessionId, step.tool, step.args, reproDir, now)
  }
  return undefined
}

/**
 * Register one track_b session with no emittable step: appends one JSON
 * line to `breakages.jsonl` naming the first failing step (or nulls when
 * the session has no failing step at all).
 *
 * @param aggregate - Finalized per-session aggregate.
 * @param reproDir - Reproduction directory (created recursively).
 * @param now - Emit-time epoch millis.
 * @returns No return value; the register line is appended.
 */
export function appendBreakage(aggregate: SessionAggregate, reproDir: string, now: number): void {
  const step = aggregate.toolSteps.find(candidate => !candidate.ok)
  const row: TrackBBreakage = {
    ts: now,
    sessionId: aggregate.sessionId,
    tool: step?.tool ?? null,
    error: step?.error ?? null,
    digest: step?.resultDigest ?? null,
  }
  mkdirSync(reproDir, { recursive: true })
  appendFileSync(join(reproDir, 'breakages.jsonl'), `${JSON.stringify(row)}\n`)
}

/**
 * Finalize-time Track B recording: emit a reproduction spec, else (no
 * emittable parser-class step) register the known breakage. Filesystem
 * failures propagate to the caller's containment (finalize never throws).
 *
 * @param aggregate - Finalized per-session aggregate.
 * @param reproDir - Reproduction directory (the `.dsh/reproductions`
 * protocol location, chosen by the caller).
 * @param now - Emit-time epoch millis.
 * @param log - Diagnostics sink for the emission or the skip.
 * @returns The emitted reproduction, or undefined when the session
 * registered a breakage instead (the caller's spec-runner hook: only the
 * emit path has a spec to execute).
 */
export function recordTrackB(
  aggregate: SessionAggregate,
  reproDir: string,
  now: number,
  log: (message: string) => void,
): TrackBReproduction | undefined {
  const emitted = emitReproduction(aggregate, reproDir, now)
  if (emitted === undefined) {
    appendBreakage(aggregate, reproDir, now)
    log(`session-meta: track_b ${aggregate.sessionId} has no emittable parser crash; breakage registered`)
    return undefined
  }
  log(`session-meta: track_b ${aggregate.sessionId} reproduction written to ${emitted.file}`)
  return emitted
}

/**
 * Protocol timeout for one Track B reproduction run: the spawned Vitest
 * invocation is killed with SIGKILL past this bound and ledgers -1.
 */
export const TRACKB_RUN_TIMEOUT_MS = 60_000

/**
 * Resolve the Vitest binary by walking up at most 6 levels from `startDir`
 * (itself plus 5 ancestors) looking for `node_modules/.bin/vitest` as a
 * file. Pure and synchronous: unit-covered with tmp dirs.
 *
 * @param startDir - Directory to start the upward walk from.
 * @returns The binary path, or undefined when no level holds one.
 */
export function resolveVitestBin(startDir: string): string | undefined {
  let dir = startDir
  for (let level = 0; level < 6; level += 1) {
    const candidate = join(dir, 'node_modules', '.bin', 'vitest')
    try {
      if (statSync(candidate).isFile()) return candidate
    } catch {
      // No usable binary at this level (missing path or unreadable ancestor): keep climbing.
    }
    const parent = dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
  return undefined
}

/** Inputs for one fire-and-forget reproduction run. */
export interface RunReproductionArgs {
  /** Emitted spec file to execute. */
  readonly file: string
  /** Vitest binary resolved by {@link resolveVitestBin}. */
  readonly vitestBin: string
  /** Kill bound in millis; past it the child dies with SIGKILL and ledgers -1. */
  readonly timeoutMs: number
  /** Ledger receiving the `trackb_runs` row. */
  readonly store: MetaStore
  /** Run timestamp (UTC millis) recorded as the row's `ts`. */
  readonly now: number
  /** Diagnostics sink for the single settle log line. */
  readonly log: (message: string) => void
}

/**
 * Run one emitted spec (`vitest run <file> --config <dir>/.trackb.vitest.config.ts
 * --reporter=default`, `cwd = dirname(file)`) and ledger the outcome. Never rejects: every
 * failure mode — spawn error, signal death, timeout SIGKILL, even a failed
 * ledger insert — ends as a -1 row plus one log line.
 *
 * NON-GOAL (M4 close): no curator hook reads these outcomes. A passing repro
 * means the bug still reproduces — it attaches to a session, not a skill, so
 * no skill earns +0.10 from it; completion evidence for skills already flows
 * through the turnEnd completed predicate. The ledger is the audit trail;
 * invalidation (the spec goes red = possibly fixed upstream) stays
 * human/reviewer-side until M5.
 *
 * @param args - Spec file, binary, timeout, ledger, timestamp, and log sink.
 * @returns No return value; the `trackb_runs` row and the log line land on settle.
 */
export async function runReproduction(args: RunReproductionArgs): Promise<void> {
  const exitCode = await runVitest(args.file, args.vitestBin, args.timeoutMs)
  try {
    args.store.recordTrackBRun(args.now, args.file, exitCode)
  } catch {
    // Ledger insert failed (a closed store during teardown): the log line below stays the audit trail.
  }
  args.log(`session-meta: track_b repro ${args.file} exited ${exitCode}`)
}

/** Inputs for one finalize-time repro disposition. */
export interface StartReproRunOptions {
  /** Emitted spec, or undefined on the breakage path (no spec to run). */
  readonly emitted: TrackBReproduction | undefined
  /** Directory to start the {@link resolveVitestBin} upward walk from. */
  readonly startDir: string
  /** Kill bound in millis; past it the child dies with SIGKILL and ledgers -1. */
  readonly timeoutMs: number
  /** Ledger receiving the `trackb_runs` row. */
  readonly store: MetaStore
  /** Run timestamp (UTC millis) recorded as the row's `ts`. */
  readonly now: number
  /** Diagnostics sink for the skip or settle log line. */
  readonly log: (message: string) => void
}

/**
 * Finalize-time disposition for an emitted spec: run it under Vitest, or
 * resolve to a no-op (breakages have no spec; a missing binary skips the
 * run with one log line). The caller tracks the returned promise in its
 * settle set; production flush stays non-blocking.
 *
 * @param options - Emitted spec, binary search root, timeout, ledger,
 * timestamp, and log sink.
 * @returns The tracked run promise; already resolved when nothing runs.
 */
export function startReproRun(options: StartReproRunOptions): Promise<void> {
  if (options.emitted === undefined) return Promise.resolve()
  const vitestBin = resolveVitestBin(options.startDir)
  if (vitestBin === undefined) {
    options.log('session-meta: track_b runner skipped (no vitest binary)')
    return Promise.resolve()
  }
  return runReproduction({
    file: options.emitted.file,
    vitestBin,
    timeoutMs: options.timeoutMs,
    store: options.store,
    now: options.now,
    log: options.log,
  })
}

/**
 * Name of the generated per-run Vitest config beside emitted specs. An
 * explicit `--config` fully replaces upward config discovery: without it a
 * spec living under a checkout would inherit that checkout's restrictive
 * `include` filters and coverage gates and exit 1 before running a test.
 */
export const TRACKB_VITEST_CONFIG = '.trackb.vitest.config.ts'

/** Minimal run config: only sibling specs match, coverage stays off. */
const TRACKB_CONFIG_SOURCE = `export default { test: { include: ['*.spec.ts'], coverage: { enabled: false } } }\n`

/**
 * Spawn the Vitest run and settle its exit code: the process code, or -1 on
 * spawn error, signal death, or timeout SIGKILL. Never rejects.
 *
 * @param file - Spec file to execute.
 * @param vitestBin - Vitest binary path.
 * @param timeoutMs - Kill bound in millis.
 * @returns The exit code, or -1 when no code is observable.
 */
function runVitest(file: string, vitestBin: string, timeoutMs: number): Promise<number> {
  return new Promise<number>((resolve) => {
    let child: ChildProcess
    try {
      const dir = dirname(file)
      writeFileSync(join(dir, TRACKB_VITEST_CONFIG), TRACKB_CONFIG_SOURCE)
      child = spawn(vitestBin, ['run', file, '--config', join(dir, TRACKB_VITEST_CONFIG), '--reporter=default'], { cwd: dir, stdio: 'ignore' })
    } catch {
      // Synchronous failure (bad cwd, unwritable dir): nothing to kill or await.
      resolve(-1)
      return
    }
    let settled = false
    const finish = (code: number): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(code)
    }
    const timer = setTimeout(() => {
      /* v8 ignore start -- kill with a valid signal on a live handle does not throw; the guard is crash containment. */
      try {
        child.kill('SIGKILL')
      } catch {
        // Already exited between the timeout and the kill: close/error settles below.
      }
      /* v8 ignore stop */
      finish(-1)
    }, timeoutMs)
    child.on('error', () => {
      finish(-1)
    })
    child.on('close', (code) => {
      finish(code ?? -1)
    })
  })
}
