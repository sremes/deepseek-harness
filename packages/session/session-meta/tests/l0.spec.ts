import { describe, expect, it } from 'vitest'
import type { EvaluatorProposal } from '../src/types.ts'
import { renderDraft } from '../src/writer.ts'
import { evaluateL0 } from '../src/l0.ts'

const BASE: EvaluatorProposal = {
  intent: 'Confirm destructive paths before running them',
  forbidden: ['Never run rm -rf on unconfirmed paths'],
  prescribed: ['Echo the resolved path and wait for confirmation'],
  triggerSignature: 'destructive-path-confirm',
  triggerConditions: 'Use when a task deletes or overwrites paths outside a scratch directory',
  platform: 'dsh-headless',
}

function draftFor(proposal: EvaluatorProposal): string {
  return renderDraft(proposal, { sessions: ['s1'], mode: 'headless' }, 'destructive-path-confirm')
}

const VALID = draftFor(BASE)

describe('evaluateL0 valid drafts', () => {
  it('passes a writer-rendered draft', () => {
    expect(evaluateL0(VALID)).toEqual({ pass: true, violations: [] })
  })

  it('passes when Forbidden holds only the placeholder', () => {
    expect(evaluateL0(draftFor({ ...BASE, forbidden: [] }))).toEqual({ pass: true, violations: [] })
  })

  it('tolerates blank lines and stray colon-less lines in frontmatter', () => {
    const text = VALID.replace('metadata:\n', 'metadata:\n\nstray words\n  stray indent\n')
    expect(evaluateL0(text)).toEqual({ pass: true, violations: [] })
  })

  it('ignores other headings and stray bullets outside both sections', () => {
    const text = `${VALID.replace('## Forbidden', '- stray remark before sections\n\n## Forbidden')}\n## Notes\n\n- a note bullet\n`
    expect(evaluateL0(text)).toEqual({ pass: true, violations: [] })
  })
})

describe('evaluateL0 frontmatter', () => {
  it('rejects empty input', () => {
    const result = evaluateL0('')
    expect(result.pass).toBe(false)
    expect(result.violations).toEqual(
      expect.arrayContaining([expect.stringContaining('frontmatter: missing or unparsable')]),
    )
  })

  it('rejects text without a frontmatter block', () => {
    const result = evaluateL0('# Just a skill\n\n## Forbidden\n\n- Never\n')
    expect(result.pass).toBe(false)
    expect(result.violations).toEqual(
      expect.arrayContaining([expect.stringContaining('frontmatter: missing or unparsable')]),
    )
  })

  it('rejects an unclosed frontmatter block', () => {
    const result = evaluateL0('---\nname: half-written\n')
    expect(result.pass).toBe(false)
    expect(result.violations).toEqual(
      expect.arrayContaining([expect.stringContaining('frontmatter: missing or unparsable')]),
    )
  })

  it('rejects a missing name', () => {
    const result = evaluateL0(VALID.replace('name: destructive-path-confirm\n', ''))
    expect(result.pass).toBe(false)
    expect(result.violations).toEqual(expect.arrayContaining([expect.stringContaining('"name"')]))
  })

  it('rejects a missing description', () => {
    const result = evaluateL0(VALID.replace(/^description: .*$/m, ''))
    expect(result.pass).toBe(false)
    expect(result.violations).toEqual(expect.arrayContaining([expect.stringContaining('"description"')]))
  })

  it('rejects a missing whenToUse', () => {
    const result = evaluateL0(VALID.replace(/^whenToUse: .*$/m, ''))
    expect(result.pass).toBe(false)
    expect(result.violations).toEqual(expect.arrayContaining([expect.stringContaining('"whenToUse"')]))
  })

  it('rejects disable-model-invocation set to false', () => {
    const result = evaluateL0(VALID.replace('disable-model-invocation: true', 'disable-model-invocation: false'))
    expect(result.pass).toBe(false)
    expect(result.violations).toEqual(
      expect.arrayContaining([expect.stringContaining('"disable-model-invocation" must be true')]),
    )
  })

  it('rejects a missing disable-model-invocation', () => {
    const result = evaluateL0(VALID.replace('disable-model-invocation: true\n', ''))
    expect(result.pass).toBe(false)
    expect(result.violations).toEqual(
      expect.arrayContaining([expect.stringContaining('"disable-model-invocation" must be true')]),
    )
  })

  it('rejects a missing confidence_score', () => {
    const result = evaluateL0(VALID.replace('  confidence_score: 0\n', ''))
    expect(result.pass).toBe(false)
    expect(result.violations).toEqual(expect.arrayContaining([expect.stringContaining('"confidence_score"')]))
  })

  it('rejects a missing trigger_signature', () => {
    const result = evaluateL0(VALID.replace('  trigger_signature: destructive-path-confirm\n', ''))
    expect(result.pass).toBe(false)
    expect(result.violations).toEqual(expect.arrayContaining([expect.stringContaining('"trigger_signature"')]))
  })

  it('rejects a missing provenance', () => {
    const result = evaluateL0(VALID.replace(/^  provenance: .*$/m, ''))
    expect(result.pass).toBe(false)
    expect(result.violations).toEqual(expect.arrayContaining([expect.stringContaining('"provenance"')]))
  })
})

describe('evaluateL0 sections', () => {
  it('rejects a missing Forbidden section', () => {
    const result = evaluateL0(VALID.replace('## Forbidden', '## Banned'))
    expect(result.pass).toBe(false)
    expect(result.violations).toEqual(
      expect.arrayContaining([expect.stringContaining('missing "## Forbidden"')]),
    )
  })

  it('rejects a Forbidden heading with no bullets', () => {
    const text = draftFor({ ...BASE, forbidden: [] }).replace('- (none recorded)\n', '')
    const result = evaluateL0(text)
    expect(result.pass).toBe(false)
    expect(result.violations).toEqual(
      expect.arrayContaining([expect.stringContaining('"## Forbidden" has no clauses')]),
    )
  })

  it('rejects a missing Prescribed section', () => {
    const result = evaluateL0(VALID.replace('## Prescribed', '## Suggested'))
    expect(result.pass).toBe(false)
    expect(result.violations).toEqual(
      expect.arrayContaining([expect.stringContaining('missing "## Prescribed"')]),
    )
  })

  it('rejects a Prescribed section with only the placeholder', () => {
    const result = evaluateL0(draftFor({ ...BASE, prescribed: [] }))
    expect(result.pass).toBe(false)
    expect(result.violations).toEqual(
      expect.arrayContaining([expect.stringContaining('"## Prescribed" must have at least one real clause')]),
    )
  })

  it('rejects a Prescribed heading with no bullets', () => {
    const text = draftFor({ ...BASE, prescribed: [] }).replace('- (none recorded)\n', '')
    const result = evaluateL0(text)
    expect(result.pass).toBe(false)
    expect(result.violations).toEqual(
      expect.arrayContaining([expect.stringContaining('"## Prescribed" must have at least one real clause')]),
    )
  })
})

describe('evaluateL0 mechanizable bans', () => {
  it('rejects a PR reference in a forbidden clause', () => {
    const result = evaluateL0(draftFor({ ...BASE, forbidden: ['Recheck the fix from PR #12345 before merging'] }))
    expect(result.pass).toBe(false)
    expect(result.violations).toEqual(
      expect.arrayContaining([expect.stringContaining('forbidden clause 0: session-specific PR reference')]),
    )
  })

  it('rejects a 40-hex commit SHA in a prescribed clause', () => {
    const sha = 'a'.repeat(40)
    const result = evaluateL0(draftFor({ ...BASE, prescribed: [`Pin the retry to commit ${sha} from the incident log`] }))
    expect(result.pass).toBe(false)
    expect(result.violations).toEqual(
      expect.arrayContaining([expect.stringContaining('prescribed clause 0: 40-hex commit SHA')]),
    )
  })

  it('rejects an ISO incident date in a prescribed clause', () => {
    const result = evaluateL0(
      draftFor({ ...BASE, prescribed: ['Replay the 2026-09-04 deploy sequence to verify the fix'] }),
    )
    expect(result.pass).toBe(false)
    expect(result.violations).toEqual(
      expect.arrayContaining([expect.stringContaining('prescribed clause 0: incident date')]),
    )
  })

  it('rejects a slash incident date in a forbidden clause', () => {
    const result = evaluateL0(
      draftFor({ ...BASE, forbidden: ['Never copy the 09/04/2026 incident workaround'] }),
    )
    expect(result.pass).toBe(false)
    expect(result.violations).toEqual(
      expect.arrayContaining([expect.stringContaining('forbidden clause 0: incident date')]),
    )
  })

  it('rejects a negative-capability claim in a prescribed clause', () => {
    const result = evaluateL0(
      draftFor({ ...BASE, prescribed: ['Note that the old sync does not work with large trees'] }),
    )
    expect(result.pass).toBe(false)
    expect(result.violations).toEqual(
      expect.arrayContaining([expect.stringContaining('prescribed clause 0: negative-capability claim')]),
    )
  })

  it('rejects a broken claim in a forbidden clause', () => {
    const result = evaluateL0(draftFor({ ...BASE, forbidden: ['The cache is broken so avoid it'] }))
    expect(result.pass).toBe(false)
    expect(result.violations).toEqual(
      expect.arrayContaining([expect.stringContaining('forbidden clause 0: negative-capability claim')]),
    )
  })

  it('accumulates every violation in one result', () => {
    const text = VALID.replace('name: destructive-path-confirm\n', '').replace(
      'Echo the resolved path and wait for confirmation',
      'Reuse the helper from PR #12345 because the old tool is unusable',
    )
    const result = evaluateL0(text)
    expect(result.pass).toBe(false)
    expect(result.violations.length).toBeGreaterThan(1)
    expect(result.violations).toEqual(
      expect.arrayContaining([
        expect.stringContaining('"name"'),
        expect.stringContaining('session-specific PR reference'),
        expect.stringContaining('negative-capability claim'),
      ]),
    )
  })
})
