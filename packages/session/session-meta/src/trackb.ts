/**
 * M4 Track B reproduction emitter (Plan-V1 §3.5): deterministic crash
 * reports as Vitest specs under `.dsh/reproductions/`, plus the
 * known-breakages register for sessions with nothing emittable. No LLM, no
 * budget, no schema change — file emission only.
 *
 * @module @deepseek-ai/dsh-session-meta/trackb
 */

import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { SessionAggregate } from './types.ts'
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
 * @returns No return value; exactly one of emit/register runs.
 */
export function recordTrackB(
  aggregate: SessionAggregate,
  reproDir: string,
  now: number,
  log: (message: string) => void,
): void {
  const emitted = emitReproduction(aggregate, reproDir, now)
  if (emitted === undefined) {
    appendBreakage(aggregate, reproDir, now)
    log(`session-meta: track_b ${aggregate.sessionId} has no emittable parser crash; breakage registered`)
  } else {
    log(`session-meta: track_b ${aggregate.sessionId} reproduction written to ${emitted.file}`)
  }
}
