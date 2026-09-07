/**
 * M3 L0 contract gate (Plan-V1 §4.1): deterministic validation of a rendered
 * `SKILL.md` draft as emitted by `writer.ts`. Every check is mechanical — no
 * LLM involved. A draft passes only when its frontmatter parses with the
 * required fields, its metadata is present, its Forbidden/Prescribed sections
 * carry real clauses, and no clause carries session-specific identifiers or
 * negative-capability claims.
 *
 * @module @deepseek-ai/dsh-session-meta/l0
 */

/** Placeholder bullet the writer emits for an empty clause list. */
const NONE_RECORDED = '(none recorded)'

/** Session-specific PR reference such as `#12345`. */
const PR_PATTERN = /#\d+\b/
/** 40-hex commit SHA. */
const SHA_PATTERN = /\b[0-9a-f]{40}\b/i
/** ISO incident date such as `2026-09-04`. */
const ISO_DATE_PATTERN = /\b\d{4}-\d{2}-\d{2}\b/
/** Slash incident date such as `09/04/2026`. */
const SLASH_DATE_PATTERN = /\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/
/** Negative-capability claim that hardens into a refusal. */
const NEGATIVE_CAPABILITY_PATTERN = /\b(broken|does not work|do not work|can't be used|cannot be used|unusable)\b/i

interface SplitText {
  readonly frontmatter: readonly string[]
  readonly body: readonly string[]
  readonly ok: boolean
}

// Split the leading `---` frontmatter block from the markdown body. Only the
// writer's exact shape is accepted: the first line must open the block and a
// later line must close it.
function splitFrontmatter(draftText: string): SplitText {
  const lines = draftText.split('\n')
  const [first, ...rest] = lines
  if ((first ?? '').trim() !== '---') return { frontmatter: [], body: lines, ok: false }
  const closeAt = rest.findIndex(line => line.trim() === '---')
  if (closeAt < 0) return { frontmatter: [], body: lines, ok: false }
  return { frontmatter: rest.slice(0, closeAt), body: rest.slice(closeAt + 1), ok: true }
}

interface FrontmatterFields {
  readonly fields: Map<string, string>
  readonly metadata: Map<string, string>
}

// Parse frontmatter `key: value` lines. Indented lines belong to `metadata:`
// (the writer's shape); anything else is a top-level field. Lines without a
// colon are ignored so a stray prose line cannot break the gate.
function parseFrontmatterFields(frontmatter: readonly string[]): FrontmatterFields {
  const fields = new Map<string, string>()
  const metadata = new Map<string, string>()
  for (const raw of frontmatter) {
    if (raw.trim() === '') continue
    if (raw.startsWith(' ') || raw.startsWith('\t')) {
      const colon = raw.indexOf(':')
      if (colon < 0) continue
      metadata.set(raw.slice(0, colon).trim(), raw.slice(colon + 1).trim())
      continue
    }
    const colon = raw.indexOf(':')
    if (colon < 0) continue
    const key = raw.slice(0, colon).trim()
    if (key === 'metadata') continue
    fields.set(key, raw.slice(colon + 1).trim())
  }
  return { fields, metadata }
}

interface BodySections {
  readonly forbidden: string[]
  readonly prescribed: string[]
  readonly hasForbidden: boolean
  readonly hasPrescribed: boolean
}

// Collect `- ` bullets under each `## Forbidden` / `## Prescribed` heading. A
// later `## ` heading ends the current section; stray bullets outside both
// sections are ignored.
function parseBodySections(body: readonly string[]): BodySections {
  const forbidden: string[] = []
  const prescribed: string[] = []
  let hasForbidden = false
  let hasPrescribed = false
  let current: 'forbidden' | 'prescribed' | 'none' = 'none'
  for (const raw of body) {
    const line = raw.trim()
    if (/^##\s+Forbidden\s*$/.test(line)) {
      hasForbidden = true
      current = 'forbidden'
      continue
    }
    if (/^##\s+Prescribed\s*$/.test(line)) {
      hasPrescribed = true
      current = 'prescribed'
      continue
    }
    if (/^##\s+/.test(line)) {
      current = 'none'
      continue
    }
    if (!/^\s*-\s+/.test(raw)) continue
    const clause = raw.replace(/^\s*-\s+/, '').trim()
    if (current === 'forbidden') forbidden.push(clause)
    else if (current === 'prescribed') prescribed.push(clause)
  }
  return { forbidden, prescribed, hasForbidden, hasPrescribed }
}

// Real clauses exclude blanks and the writer's `(none recorded)` placeholder.
function realClauses(clauses: readonly string[]): string[] {
  return clauses.filter(clause => !['', NONE_RECORDED].includes(clause))
}

// Record one violation per banned pattern found in a real clause.
function scanClauses(violations: string[], section: string, clauses: readonly string[]): void {
  let index = 0
  for (const clause of clauses) {
    if (PR_PATTERN.test(clause)) violations.push(`${section} clause ${index}: session-specific PR reference`)
    if (SHA_PATTERN.test(clause)) violations.push(`${section} clause ${index}: 40-hex commit SHA`)
    if (ISO_DATE_PATTERN.test(clause) || SLASH_DATE_PATTERN.test(clause)) {
      violations.push(`${section} clause ${index}: incident date`)
    }
    if (NEGATIVE_CAPABILITY_PATTERN.test(clause)) violations.push(`${section} clause ${index}: negative-capability claim`)
    index += 1
  }
}

/**
 * Evaluate one rendered `SKILL.md` draft against the L0 contract. Pure:
 * every violation is a mechanical finding, never a model judgment.
 *
 * @param draftText - rendered `SKILL.md` text as emitted by `renderDraft`.
 * @returns pass true only when violations is empty, plus one entry per violation.
 */
export function evaluateL0(draftText: string): { pass: boolean; violations: string[] } {
  const violations: string[] = []
  const { frontmatter, body, ok } = splitFrontmatter(draftText)
  if (!ok) {
    violations.push('frontmatter: missing or unparsable frontmatter block')
  } else {
    const { fields, metadata } = parseFrontmatterFields(frontmatter)
    if ((fields.get('name') ?? '').trim() === '') violations.push('frontmatter: missing required field "name"')
    if ((fields.get('description') ?? '').trim() === '') violations.push('frontmatter: missing required field "description"')
    if ((fields.get('whenToUse') ?? '').trim() === '') violations.push('frontmatter: missing required field "whenToUse"')
    if (fields.get('disable-model-invocation') !== 'true') {
      violations.push('frontmatter: "disable-model-invocation" must be true')
    }
    if ((metadata.get('confidence_score') ?? '').trim() === '') {
      violations.push('metadata: missing required field "confidence_score"')
    }
    if ((metadata.get('trigger_signature') ?? '').trim() === '') {
      violations.push('metadata: missing required field "trigger_signature"')
    }
    if ((metadata.get('provenance') ?? '').trim() === '') {
      violations.push('metadata: missing required field "provenance"')
    }
  }
  const sections = parseBodySections(body)
  if (!sections.hasForbidden) {
    violations.push('body: missing "## Forbidden" section')
  } else if (sections.forbidden.length === 0) {
    violations.push('body: "## Forbidden" has no clauses')
  }
  if (!sections.hasPrescribed) {
    violations.push('body: missing "## Prescribed" section')
  } else if (realClauses(sections.prescribed).length === 0) {
    violations.push('body: "## Prescribed" must have at least one real clause')
  }
  scanClauses(violations, 'forbidden', realClauses(sections.forbidden))
  scanClauses(violations, 'prescribed', realClauses(sections.prescribed))
  return { pass: violations.length === 0, violations }
}
