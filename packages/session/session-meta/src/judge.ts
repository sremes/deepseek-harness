/**
 * M3 L4-lite pairwise judge (Plan-V1 §4.1): a blinded, order-swapped Flash
 * verdict over one candidate/baseline pair. Harm veto only, never proof of
 * gain: any preference for the baseline on either run vetoes, split verdicts
 * veto, and unparseable output fails closed. Pure helpers (prompt building,
 * verdict parsing) stay separate from the streaming call so every branch is
 * unit-testable with a fake `llm.stream`.
 *
 * @module @deepseek-ai/dsh-session-meta/judge
 */

import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Message } from '@deepseek-ai/dsh-llm'
import type { EvaluatorLlm, EvaluatorRoute } from './evaluator.ts'

/** Blinded pairwise verdict: which presented approach the judge preferred. */
export type JudgeVerdict = 'prefer-a' | 'prefer-b' | 'tie'

/** One parsed judge verdict plus the tool-grounded justification. */
export interface JudgeResult {
  readonly verdict: JudgeVerdict
  readonly grounds: string
}

const JUDGE_SYSTEM = [
  'You judge which of two approaches to the same task worked better.',
  'The approaches are blinded: compare only what each trace shows.',
].join('\n')

/**
 * Build the blinded pairwise judge prompt. The two summaries arrive as
 * `Approach A` / `Approach B` with no skill identity attached; the rubric
 * applies in fixed order (correctness, then robustness, then efficiency)
 * and every claim must cite the tool call or result evidencing it.
 *
 * @param aSummary - trace summary presented as Approach A.
 * @param bSummary - trace summary presented as Approach B.
 * @returns the user prompt text for one judge run.
 */
export function buildJudgePrompt(aSummary: string, bSummary: string): string {
  return [
    'Compare two approaches to the same task. Judge only what each trace shows, never any skill identity.',
    'Apply this rubric in fixed order: correctness, then robustness, then efficiency.',
    'Every claim in your grounds must cite the tool call or result evidencing it.',
    'Approach A:',
    aSummary,
    'Approach B:',
    bSummary,
    'Reply with exactly one JSON object, no fences, no prose: {"verdict": "prefer-a" | "prefer-b" | "tie", "grounds": "why, citing the tool calls and results"}.',
  ].join('\n')
}

/**
 * Strictly parse one judge verdict from model text. Fences, prose, unknown
 * verdict strings, missing or empty grounds, and malformed JSON all yield
 * `undefined` — ties need grounds, so an empty-grounds tie is unparseable.
 *
 * @param text - raw model output for one judge run.
 * @returns the parsed verdict, or undefined when the output is not a single valid verdict object.
 */
export function parseJudgeJson(text: string): JudgeResult | undefined {
  const body = text.trim()
  if (!body.startsWith('{') || !body.endsWith('}')) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(body) as unknown
  } catch {
    // Non-JSON output is unparseable and fails closed downstream.
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
  const record = parsed as Record<string, unknown>
  if (record.verdict === 'prefer-a' || record.verdict === 'prefer-b' || record.verdict === 'tie') {
    const grounds: unknown = record.grounds
    if (typeof grounds !== 'string' || grounds.trim() === '') return undefined
    return { verdict: record.verdict, grounds }
  }
  return undefined
}

/**
 * Run one judge call and fail closed: stream, assemble text-only output,
 * and parse the verdict. Any transport, budget, shape, or parse failure
 * yields `undefined` instead of throwing.
 *
 * @param llm - minimal streaming surface (mirrors the evaluator).
 * @param route - provider, model, and budget limits.
 * @param aSummary - trace summary presented as Approach A.
 * @param bSummary - trace summary presented as Approach B.
 * @returns the parsed verdict, or undefined on any failure.
 */
async function runOneJudge(
  llm: EvaluatorLlm,
  route: EvaluatorRoute,
  aSummary: string,
  bSummary: string,
): Promise<JudgeResult | undefined> {
  try {
    const prompt = buildJudgePrompt(aSummary, bSummary)
    if (Buffer.byteLength(prompt, 'utf8') > route.maxInputBytes) return undefined
    const messages: Message[] = [createUserMessage({
      content: [{ type: 'text', text: prompt }],
      source: { kind: 'plugin', plugin: 'dsh-session-meta' },
    })]
    const deadline = AbortSignal.timeout(route.timeoutMs)
    const assembler = new BlockAssembler()
    for await (const chunk of llm.stream({
      provider: route.provider,
      model: route.model,
      messages,
      system: JUDGE_SYSTEM,
      maxTokens: route.maxOutputTokens,
      signal: deadline,
    })) {
      deadline.throwIfAborted()
      assembler.push(chunk)
    }
    deadline.throwIfAborted()
    const finish = assembler.finish as { kind?: unknown }
    if (typeof finish.kind === 'string' && (finish.kind === 'length' || finish.kind.includes('error'))) {
      return undefined
    }
    const blocks = assembler.blocks()
    if (blocks.some(block => block.type === 'tool-call')) return undefined
    const text = blocks
      .filter((block): block is Extract<typeof blocks[number], { type: 'text' }> => block.type === 'text')
      .map(block => block.text)
      .join(' ')
    if (text.trim() === '') return undefined
    return parseJudgeJson(text)
  } catch {
    // Stream aborts, adapter throws, and budget overruns all fail closed: the pair is vetoed, never passed.
    return undefined
  }
}

/**
 * Judge a candidate against its baseline twice, order-swapped: first with
 * A = candidate, B = baseline, then with A = baseline, B = candidate.
 * `prefer-a` / `prefer-b` map back to candidate / baseline per run.
 * Pass needs both runs to prefer the candidate or tie with grounds; any
 * baseline preference (harm veto), any disagreement, or any unparseable
 * run fails.
 *
 * @param llm - minimal streaming surface (mirrors the evaluator).
 * @param route - provider, model, and budget limits.
 * @param candidateSummary - trace summary of the candidate approach.
 * @param baselineSummary - trace summary of the baseline approach.
 * @returns pass plus both runs' grounds on pass, or whatever grounds were obtained on fail.
 */
export async function judgePair(
  llm: EvaluatorLlm,
  route: EvaluatorRoute,
  candidateSummary: string,
  baselineSummary: string,
): Promise<{ pass: boolean; grounds: string[] }> {
  const first = await runOneJudge(llm, route, candidateSummary, baselineSummary)
  const second = await runOneJudge(llm, route, baselineSummary, candidateSummary)
  const grounds: string[] = []
  if (first !== undefined) grounds.push(first.grounds)
  if (second !== undefined) grounds.push(second.grounds)
  const firstSide = toCandidateSide(first, true)
  const secondSide = toCandidateSide(second, false)
  const pass =
    (firstSide === 'candidate' || firstSide === 'tie') &&
    (secondSide === 'candidate' || secondSide === 'tie')
  return { pass, grounds }
}

/**
 * Map one blinded verdict back to the candidate/baseline frame.
 *
 * @param result - parsed verdict of one run, or undefined when it failed closed.
 * @param aIsCandidate - true when Approach A was the candidate in that run.
 * @returns the candidate-frame side, or undefined when the run is unusable.
 */
function toCandidateSide(
  result: JudgeResult | undefined,
  aIsCandidate: boolean,
): 'candidate' | 'baseline' | 'tie' | undefined {
  if (result === undefined) return undefined
  if (result.verdict === 'tie') return 'tie'
  const prefersA = result.verdict === 'prefer-a'
  return prefersA === aIsCandidate ? 'candidate' : 'baseline'
}
