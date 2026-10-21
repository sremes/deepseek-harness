/**
 * Gated skill-draft writer: persists an evaluator proposal
 * as a `SKILL.md` draft under the user skill root with
 * `disable-model-invocation: true` — the draft stays user-only until the
 * The validation pipeline flips the flag. Rendering is pure; only `writeSkillDraft`
 * touches the filesystem, creates directories, and guarantees it never
 * overwrites an existing skill.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { EvaluatorProposal, SkillDraft } from './types.ts'

/** Provenance recorded into the draft frontmatter. */
export interface DraftProvenance {
  readonly sessions: readonly string[]
  readonly mode: string
}

/** Cap on the frontmatter description line. */
export const MAX_DRAFT_DESCRIPTION_CHARS = 200

/** Gated-draft flag line: present while the draft is user-only. */
export const DISABLE_MODEL_INVOCATION_LINE = 'disable-model-invocation: true'

/** Draft-only footer sentence, replaced on promotion. */
export const DRAFT_ONLY_FOOTER = 'Draft only: model invocation is disabled until the promotion pipeline passes.'

/** Promoted footer sentence, carrying the provenance pointer. */
export const PROMOTED_FOOTER = 'Promoted by the learning loop; provenance above.'

/**
 * Slugify free text into the skill-name grammar
 * (`^[a-z0-9]+(?:-[a-z0-9]+)*$`): lowercase, runs of other chars become one
 * dash, leading/trailing dashes trimmed, empty falls back to `skill-draft`.
 */
export function slugify(text: string): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '')
  return slug === '' ? 'skill-draft' : slug
}

/** Render one gated `SKILL.md` draft. Pure: byte-exact output, unit-covered.
 *
 * Frontmatter metadata carries EXPERIENCE.md provenance derived only from
 * the proposal plus the provenance arg: `cue` is the proposal's
 * `triggerConditions` verbatim, `lesson` is the proposal's `intent`
 * verbatim, and `evidence` is the proposal's `evidence` entries plus one
 * `session:<id>` entry per provenance session, JSON-encoded.
 */
export function renderDraft(proposal: EvaluatorProposal, provenance: DraftProvenance, slug: string): string {
  const description = proposal.intent.replace(/\s+/g, ' ').trim().slice(0, MAX_DRAFT_DESCRIPTION_CHARS)
  const forbidden = proposal.forbidden.map(clause => `- ${clause}`).join('\n')
  const prescribed = proposal.prescribed.map(clause => `- ${clause}`).join('\n')
  return [
    '---',
    `name: ${slug}`,
    `description: ${description}`,
    `whenToUse: ${proposal.triggerConditions.replace(/\s+/g, ' ').trim()}`,
    'disable-model-invocation: true',
    'metadata:',
    '  confidence_score: 0',
    '  applied_count: 0',
    '  version: 1',
    `  trigger_signature: ${proposal.triggerSignature}`,
    `  provenance: {sessions: [${provenance.sessions.map(id => JSON.stringify(id)).join(', ')}], mode: ${JSON.stringify(provenance.mode)}}`,
    `  cue: ${proposal.triggerConditions}`,
    `  lesson: ${proposal.intent}`,
    `  evidence: ${JSON.stringify([...proposal.evidence, ...provenance.sessions.map(id => `session:${id}`)])}`,
    '---',
    '',
    `# ${proposal.intent}`,
    '',
    '## Forbidden',
    '',
    forbidden === '' ? '- (none recorded)' : forbidden,
    '',
    '## Prescribed',
    '',
    prescribed === '' ? '- (none recorded)' : prescribed,
    '',
    `_Platform: ${proposal.platform}. Draft only: model invocation is disabled until the promotion pipeline passes._`,
    '',
  ].join('\n')
}

/**
 * Write one gated draft. Picks a unique slug directory, creates it, and
 * writes `SKILL.md` exactly once — an occupied draft file is never reused,
 * the next free suffix wins.
 */
export function writeSkillDraft(
  skillsDir: string,
  proposal: EvaluatorProposal,
  provenance: DraftProvenance,
): SkillDraft {
  const base = slugify(proposal.triggerSignature)
  let slug = base
  for (let attempt = 2; existsSync(join(skillsDir, slug, 'SKILL.md')); attempt += 1) {
    slug = `${base}-${attempt}`
  }
  const dir = join(skillsDir, slug)
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'SKILL.md')
  writeFileSync(file, renderDraft(proposal, provenance, slug))
  return { slug, dir, file }
}

/**
 * Promote a worker-written draft to live: remove the model-invocation flag,
 * bump the metadata version by one, and swap the draft-only footer for the
 * promoted footer. Writes the file back.
 *
 * @param dir - The skill directory holding `SKILL.md`.
 * @returns No return value; the file is rewritten in place.
 */
export function promoteDraftFile(dir: string): void {
  const file = join(dir, 'SKILL.md')
  const text = readFileSync(file, 'utf8')
  const lines = text.split('\n')
  if (!lines.includes(DISABLE_MODEL_INVOCATION_LINE)) {
    throw new Error(`session-meta: cannot promote ${file} (disable-model-invocation flag absent)`)
  }
  const flipped = lines
    .filter(line => line !== DISABLE_MODEL_INVOCATION_LINE)
    .map((line) => {
      const version = line.match(/^(\s*version:\s*)(\d+)(\s*)$/)
      if (version !== null) return `${version[1]}${Number(version[2]) + 1}${version[3]}`
      return line
    })
    .join('\n')
    .replace(DRAFT_ONLY_FOOTER, PROMOTED_FOOTER)
  writeFileSync(file, flipped)
}
