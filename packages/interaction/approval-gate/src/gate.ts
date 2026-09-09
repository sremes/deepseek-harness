/**
 * Pure deterministic layers of the approval gate: the exact-deny blacklist,
 * the narrow whole-command allowlist, and command recovery from observed
 * tool calls. No IO, no LLM — every branch is unit-covered without cordis.
 *
 * Security posture: safety is args × cwd × env × redirects, never the
 * binary name. The allowlist therefore anchors the WHOLE command and bans
 * every shell metacharacter — anything with pipes, redirects, chaining,
 * substitution, or globbing falls through to the judge. A prefix whitelist
 * without that ban is theater (`echo hi; rm -rf /` passes `^echo`).
 *
 * @module @deepseek-ai/dsh-approval-gate/gate
 */

import type { ObservedCall } from './types.ts'

/** Exact-deny patterns: destructive no matter the context. Keep tight. */
export const BLACKLIST: ReadonlyArray<RegExp> = [
  /\brm\s+(?:-[a-z]+\s+)*(\/\*|\/(?=\s|$)|\~|\$+\{?HOME\}?|\.(?=\s|$))/,
  /\b(mkfs|fdisk|parted)\b/,
  /\bdd\b.*\bof=\/dev\//,
  /:\(\)\s*{\s*:\|:\s*&\s*};:/,
  /\b(curl|wget)\b[^|]*\|\s*(sh|bash|sudo)/,
  />\s*\/dev\/(sd|hd|nvme|vd)[a-z]/,
  /\bchmod\s+-R\s+777\s+\//,
  /\b(shutdown|reboot|halt|poweroff)\b/,
  /\binit\s+[06]\b/,
]

/** Binaries ever allowlisted. The metachar ban below does the real work. */
const SAFE_BINS: ReadonlySet<string> = new Set([
  'ls', 'cat', 'echo', 'pwd', 'true', 'whoami', 'dirname', 'basename', 'which', 'node', 'git',
])

/** Shell metacharacters: any allowlist candidate containing one goes to the judge. */
const META_CHARS = /[;&|><`$(){}[\]!#~*?]/

/** `git` subcommands ever allowlisted (read-only porch). */
const SAFE_GIT: ReadonlySet<string> = new Set([
  'status', 'diff', 'log', 'rev-parse', 'branch', 'remote', 'show',
])

/**
 * Whether the command matches the blacklist (deterministic deny).
 *
 * @param command - raw `bash -c` string.
 * @returns true when any exact-deny pattern matches.
 */
export function isBlacklisted(command: string): boolean {
  return BLACKLIST.some(pattern => pattern.test(command))
}

/**
 * Narrow whole-command allow check: first token allowlisted, no shell
 * metacharacters anywhere, `git` restricted to read-only subcommands.
 *
 * @param command - raw `bash -c` string.
 * @returns true only for the boring-read-only class.
 */
export function allowlisted(command: string): boolean {
  const trimmed = command.trim()
  if (trimmed === '') return false
  if (META_CHARS.test(trimmed)) return false
  const space = trimmed.indexOf(' ')
  const bin = space === -1 ? trimmed : trimmed.slice(0, space)
  if (!SAFE_BINS.has(bin)) return false
  if (bin === 'git') {
    const rest = space === -1 ? '' : trimmed.slice(space + 1)
    const sub = rest === '' ? '' : rest.split(/\s+/)[0] as string
    if (!SAFE_GIT.has(sub)) return false
  }
  return true
}

/**
 * Recover the escalated command for one ask from observed tool calls.
 * The ask payload carries no command — only the call id links them.
 *
 * @param calls - tool calls observed so far, keyed by string call id.
 * @param callId - call id from the ask.
 * @returns the `command` argument, or undefined when unrecoverable.
 */
export function commandForCall(calls: ReadonlyMap<string, ObservedCall>, callId: string): string | undefined {
  const seen = calls.get(callId)
  if (seen === undefined) return undefined
  if (typeof seen.args !== 'string') return undefined
  try {
    const command = (JSON.parse(seen.args) as { command?: unknown }).command
    return typeof command === 'string' && command !== '' ? command : undefined
  } catch {
    return undefined
  }
}
