/**
 * Gated skill-draft writer (Plan-V1 §3.3/M2): persists an evaluator proposal
 * as a `SKILL.md` draft under the user skill root with
 * `disable-model-invocation: true` — the draft stays user-only until the
 * M3 pipeline flips the flag. Rendering is pure; only `writeSkillDraft`
 * touches the filesystem, creates directories, and guarantees it never
 * overwrites an existing skill.
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { EvaluatorProposal, SkillDraft } from './types.ts'

/** Provenance recorded into the draft frontmatter (EvoDAG-lite, Plan-V1 §4). */
export interface DraftProvenance {
  readonly sessions: readonly string[]
  readonly mode: string
}

/** Cap on the frontmatter description line. */
export const MAX_DRAFT_DESCRIPTION_CHARS = 200

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

/** Render one gated `SKILL.md` draft. Pure: byte-exact output, unit-covered. */
export function renderDraft(proposal: EvaluatorProposal, provenance: DraftProvenance, slug: string): string {
  const description = proposal.intent.replace(/\s+/g, ' ').trim().slice(0, MAX_DRAFT_DESCRIPTION_CHARS)
  const forbidden = proposal.forbidden.map(clause => `- ${clause}`).join('\n')
  const prescribed = proposal.prescribed.map(clause => `- ${clause}`).join('\n')
  return [
    '---',
    `name: ${slug}`,
    `description: ${description}`,
    'disable-model-invocation: true',
    'metadata:',
    '  confidence_score: 0',
    '  applied_count: 0',
    '  version: 1',
    `  trigger_signature: ${proposal.triggerSignature}`,
    `  provenance: {sessions: [${provenance.sessions.map(id => JSON.stringify(id)).join(', ')}], mode: ${JSON.stringify(provenance.mode)}}`,
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
    prescribed,
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
