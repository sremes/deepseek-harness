/**
 * Redaction for the session-meta store: secrets are scrubbed and paths are
 * normalized BEFORE anything reaches `meta.db`. The canonical session log is
 * never touched — redaction applies to the meta copy only.
 *
 * Covered: PEM blocks, known token prefixes (`sk-`, `ghp_`, `gho_`,
 * `github_pat_`, `xox*`, `AKIA`), `key=value` secret assignments, `cwd`
 * and home-directory normalization, and byte bounds on every retained
 * string. Deliberately NOT covered (see README): generic high-entropy
 * detection without a key anchor — too lossy for tool arguments that
 * legitimately carry hashes and ids.
 *
 * @module @deepseek-ai/dsh-session-meta/redact
 */

export interface RedactContext {
  /** Session working directory; normalized to `$CWD`. */
  readonly cwd?: string | undefined
  /** Home directory; normalized to `~`. Defaults to `process.env.HOME`. */
  readonly home?: string | undefined
  /** Per-string character bound. Default 4096. */
  readonly maxStringChars?: number | undefined
  /** Per-array item bound. Default 200. */
  readonly maxArrayItems?: number | undefined
  /** Recursion depth bound. Default 8. */
  readonly maxDepth?: number | undefined
}

export interface RedactResult {
  readonly value: unknown
  /** Number of substitutions/truncations applied. */
  readonly redactions: number
}

const DEFAULT_MAX_STRING_CHARS = 4096
const DEFAULT_MAX_ARRAY_ITEMS = 200
const DEFAULT_MAX_DEPTH = 8

const PEM_PATTERN = /-----BEGIN [A-Z0-9 ]+-----[\s\S]*?-----END [A-Z0-9 ]+-----/g
const TOKEN_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bsk-[A-Za-z0-9_-]{8,}\b/g, '[REDACTED:sk]'],
  [/\bghp_[A-Za-z0-9]{8,}\b/g, '[REDACTED:ghp]'],
  [/\bgho_[A-Za-z0-9]{8,}\b/g, '[REDACTED:gho]'],
  [/\bgithub_pat_[A-Za-z0-9_]{8,}\b/g, '[REDACTED:github-pat]'],
  [/\bxox[bpas]-[A-Za-z0-9-]{8,}\b/g, '[REDACTED:slack]'],
  [/\bAKIA[0-9A-Z]{16}\b/g, '[REDACTED:aws-key]'],
  [/\bbearer\s+[-A-Z0-9._~+/]{8,}={0,2}\b/gi, 'Bearer [REDACTED]'],
]
const SECRET_ASSIGNMENT_PATTERN =
  /((?:api[_-]?key|secret|token|password|passwd|auth|credentials?)\s*[:=]\s*)(['"]?)([^\s'";,}]+)\2/gi

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Scrub one string; returns the scrubbed string plus substitution count. */
export function redactString(input: string, context: RedactContext = {}): { text: string; redactions: number } {
  let text = input
  let redactions = 0
  const count = (next: string): void => {
    if (next !== text) redactions += 1
    text = next
  }
  count(text.replace(PEM_PATTERN, '[REDACTED:PEM]'))
  for (const [pattern, replacement] of TOKEN_PATTERNS) {
    pattern.lastIndex = 0
    count(text.replace(pattern, replacement))
  }
  SECRET_ASSIGNMENT_PATTERN.lastIndex = 0
  count(text.replace(SECRET_ASSIGNMENT_PATTERN, '$1[REDACTED]'))
  const home = context.home ?? process.env.HOME
  if (home !== undefined && home !== '') {
    const parts = text.split(home)
    if (parts.length > 1) {
      redactions += parts.length - 1
      text = parts.join('~')
    }
  }
  const cwd = context.cwd
  if (cwd !== undefined && cwd !== '') {
    const pattern = new RegExp(escapeRegExp(cwd), 'g')
    const parts = text.split(pattern)
    if (parts.length > 1) {
      redactions += parts.length - 1
      text = parts.join('$CWD')
    }
  }
  const maxChars = context.maxStringChars ?? DEFAULT_MAX_STRING_CHARS
  if (text.length > maxChars) {
    redactions += 1
    text = `${text.slice(0, maxChars)}…[truncated ${text.length - maxChars}]`
  }
  return { text, redactions }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false
  const prototype: unknown = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

/**
 * Recursively scrub a JSON-ish value. Non-plain objects (class instances,
 * functions, symbols) are replaced with a type tag — the store only keeps
 * JSON-serializable evidence.
 */
export function redactValue(value: unknown, context: RedactContext = {}, depth = 0): RedactResult {
  const maxDepth = context.maxDepth ?? DEFAULT_MAX_DEPTH
  if (depth > maxDepth) return { value: '[REDACTED:depth]', redactions: 1 }
  if (typeof value === 'string') {
    const { text, redactions } = redactString(value, context)
    return { value: text, redactions }
  }
  if (Array.isArray(value)) {
    const maxItems = context.maxArrayItems ?? DEFAULT_MAX_ARRAY_ITEMS
    const kept = value.slice(0, maxItems)
    let redactions = value.length > maxItems ? 1 : 0
    const out: unknown[] = []
    for (const item of kept) {
      const result = redactValue(item, context, depth + 1)
      redactions += result.redactions
      out.push(result.value)
    }
    if (value.length > maxItems) out.push(`…[truncated ${value.length - maxItems} items]`)
    return { value: out, redactions }
  }
  if (isPlainObject(value)) {
    let redactions = 0
    const out: Record<string, unknown> = {}
    for (const [key, entry] of Object.entries(value)) {
      const result = redactValue(entry, context, depth + 1)
      redactions += result.redactions
      out[key] = result.value
    }
    return { value: out, redactions }
  }
  if (value === null || typeof value === 'number' || typeof value === 'boolean') {
    return { value, redactions: 0 }
  }
  return { value: `[REDACTED:${typeof value}]`, redactions: 1 }
}
