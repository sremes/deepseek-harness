/**
 * Track A evaluator: a budget-capped model call over the
 * state projection plus the steering record. Input = goal + Σ + steering;
 * output = schema-validated JSON proposal. Model output is proposal-only —
 * the writer persists it as a *gated* draft and the validation pipeline
 * decides promotion. Pure helpers (prompt building, proposal parsing) stay
 * separate from the streaming call so every branch is unit-testable with a
 * fake `llm.stream`.
 */

import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Message, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { DualEvaluatorProposals, EvaluatorProposal, SessionProjection, SteeringRecord } from './types.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'session-meta': { kind: 'session-meta'; plugin: string }
  }
}

/** Attribution for evaluator/judge prompt messages authored by this plugin. */
export function sessionMetaSource(): { kind: 'session-meta'; plugin: string } {
  return { kind: 'session-meta', plugin: 'dsh-session-meta' }
}

/** Minimal structural surface of the `llm` service used by the evaluator. */
export interface EvaluatorLlm {
  stream(options: {
    provider: string
    model: string
    messages: Message[]
    system?: string | undefined
    maxTokens?: number | undefined
    signal?: AbortSignal | undefined
    sessionId?: string | undefined
  }): AsyncIterable<StreamChunk>
}

/** Resolved evaluator route and limits (from plugin config). */
export interface EvaluatorRoute {
  readonly provider: string
  readonly model: string
  readonly maxInputBytes: number
  readonly maxOutputTokens: number
  readonly timeoutMs: number
}

/** Evaluator input: projection plus every steering source. */
export interface EvaluatorInput {
  /** Owning session id: affinity key for the model call, never prompt content. */
  readonly sessionId: string
  readonly projection: SessionProjection
  readonly steering: readonly SteeringRecord[]
  /** Existing draft signatures (cheap dedup hint; full merge happens at composition). */
  readonly knownSignatures?: readonly string[] | undefined
}

/** One evaluator run: the validated proposal plus measured usage. */
export interface EvaluatorResult {
  readonly proposal: EvaluatorProposal
  readonly inputTokens: number
  readonly outputTokens: number
}

/** One dual-lens evaluator run: both validated lens proposals plus measured usage. */
export interface DualEvaluatorResult extends DualEvaluatorProposals {
  readonly inputTokens: number
  readonly outputTokens: number
}

/** Raw text plus measured usage from one evaluator call (parsing happens after). */
export interface EvaluatorReply {
  readonly text: string
  readonly inputTokens: number
  readonly outputTokens: number
}

const EVALUATOR_SYSTEM = [
  'You turn one session into a reusable skill draft.',
  'You receive a JSON state projection (goal, tool steps WITH the arguments the model actually passed, error digests, recovery marks, skills consulted, turn outcome, steering messages) plus the human correction, if any.',
  'Work in three explicit phases before writing the proposal:',
  '(a) Reference behavior: state what the session did, step by step from the projection (tools called, arguments passed, order, failures and recoveries).',
  '(b) Corrected behavior: state what the steering/correction demands instead (the intended procedure or outcome).',
  '(c) Contrast: name the tool/argument/order delta between (a) and (b) that the prescription rests on; every prescribed and forbidden clause must cite at least one evidence entry grounded in that delta.',
  'Write the procedure that worked, not a narrative of the session:',
  'Ground every clause in the delta between the correction and the observed tool parameters: never invent tools, files, or commands absent from the projection.',
  'A pitfall is a generalizable rule plus one clause of WHY (the mechanism), imperative. Never paste error transcripts, PR numbers, dates, or session-specific identifiers as content.',
  'Do not duplicate what tool schemas already teach (parameter lists, syntax). Do not claim a tool or feature is broken — describe the working pattern instead.',
  'If a step failed and a later same-tool step succeeded (recovered: true), the lesson is the retry pattern (compare args with retryArgs), not the original failure.',
  'If completed is false, the session never verified a working method: write Forbidden-clauses only and leave prescribed empty. Never present an uncompleted attempt as a verified procedure.',
  'If the correction restates what the session already did — no observable tool/argument/order delta — decline prescription: leave prescribed empty and set no_contrast to true (NO_ENTRY discipline).',
  'Prefer patching what exists: the skillsConsulted list names skills already covering this territory — aim trigger_signature at the one in play rather than inventing a parallel skill. The known_signatures list names drafts already proposed — do not re-propose them.',
  'Reply with exactly one JSON object, no fences, no prose, with keys: intent (one sentence), forbidden (array of strings, may be empty), prescribed (array of strings; non-empty when completed is true, empty when completed is false or when no_contrast is true), trigger_signature (short kebab-case symptom tag), trigger_conditions (one or two sentences: when a future session should load this skill), platform (e.g. dsh-headless or unknown), evidence (array of non-empty strings; each names the step/tool-call supporting one prescribed/forbidden clause, e.g. `step 4: retryArgs added --flag`), no_contrast (optional boolean; true only when no observable delta supports a prescription).',
  'You emit TWO lenses in one reply: an invariant lens and a domain lens.',
  'The invariant lens captures the cross-domain agentic deficiency (planning, tool use, delegation, verification habits); its trigger_signature starts with `general-` plus a kebab-case symptom (e.g. `general-unconfirmed-destructive-path`).',
  'The domain lens captures the task-specific procedure or constraints; its trigger_signature names the task symptom.',
  'Reply with exactly one JSON object, no fences, no prose, with keys invariant and domain. Each holds one proposal object with the schema above (intent, forbidden, prescribed, trigger_signature, trigger_conditions, platform, evidence, optional no_contrast), or null when that lens has no content.',
  'A lens object with no_contrast true counts as declined, like null. Missing keys count as declined. Each lens needs its own evidence array: a citation supporting clauses in both lenses must appear in each lens\u2019s evidence array to count there.',
].join('\n')

/**
 * Build the evaluator user prompt. The projection is serialized compactly;
 * callers enforce `maxInputBytes` before sending.
 */
export function buildEvaluatorPrompt(input: EvaluatorInput): string {
  return JSON.stringify({
    goal: input.projection.goal,
    steps: input.projection.steps,
    truncated_steps: input.projection.truncatedSteps,
    errors: input.projection.errors,
    turn_end: input.projection.turnEnd,
    completed: input.projection.completed,
    skills_consulted: input.projection.skillsConsulted,
    known_signatures: input.knownSignatures ?? [],
    steering_messages: input.projection.steeringTexts,
    steering_records: input.steering.map(record => ({
      original_task: record.originalTask,
      correction: record.correction,
      ...(record.intentHint === undefined ? {} : { intent_hint: record.intentHint }),
    })),
    counts: input.projection.counts,
  })
}

/**
 * Extract and schema-validate one proposal from model text. Tolerates
 * fenced code blocks; rejects anything that is not a single JSON object
 * with the required shape. `completed` gates the prescription rule:
 * only a completed session may prescribe a procedure, unless `no_contrast`
 * marks the NO_ENTRY case (the correction restates observed behavior, so no
 * prescription is owed). Every clause must cite its contrastive grounding in
 * `evidence`. Pure: throw sites are all unit-covered.
 */
export function parseProposal(text: string, completed = true): EvaluatorProposal {
  const json = extractJsonObject(text)
  let proposal: Record<string, unknown>
  try {
    proposal = JSON.parse(json) as Record<string, unknown>
  } catch {
    throw new Error('session-meta: evaluator output is not valid JSON')
  }
  if (typeof proposal.intent !== 'string' || proposal.intent.trim() === '') {
    throw new Error('session-meta: evaluator proposal needs a non-empty intent')
  }
  if (!isStringArray(proposal.forbidden)) {
    throw new Error('session-meta: evaluator proposal forbidden must be a string array')
  }
  if (proposal.no_contrast !== undefined && typeof proposal.no_contrast !== 'boolean') {
    throw new Error('session-meta: evaluator proposal no_contrast must be a boolean when present')
  }
  const noContrast = proposal.no_contrast === true
  if (!isStringArray(proposal.prescribed) || (proposal.prescribed.length === 0 && completed && !noContrast)) {
    throw new Error('session-meta: evaluator proposal prescribed must be a non-empty string array')
  }
  if (typeof proposal.trigger_signature !== 'string' || proposal.trigger_signature.trim() === '') {
    throw new Error('session-meta: evaluator proposal needs a non-empty trigger_signature')
  }
  if (typeof proposal.platform !== 'string' || proposal.platform.trim() === '') {
    throw new Error('session-meta: evaluator proposal needs a non-empty platform')
  }
  if (typeof proposal.trigger_conditions !== 'string' || proposal.trigger_conditions.trim() === '') {
    throw new Error('session-meta: evaluator proposal needs non-empty trigger_conditions')
  }
  if (!isNonEmptyStringArray(proposal.evidence)) {
    throw new Error('session-meta: evaluator proposal evidence must be a non-empty array of non-empty strings')
  }
  return {
    intent: proposal.intent,
    forbidden: proposal.forbidden,
    prescribed: proposal.prescribed,
    triggerSignature: proposal.trigger_signature,
    triggerConditions: proposal.trigger_conditions,
    platform: proposal.platform,
    evidence: proposal.evidence,
    ...(noContrast ? { noContrast: true as const } : {}),
  }
}

/**
 * Parse one dual-lens reply into its invariant and domain proposals. Each
 * present lens is independently schema-validated through `parseProposal`
 * with its own evidence (a citation used in both lenses must be duplicated
 * into each lens's evidence array). A lens is declined when its key is
 * missing, holds null, or holds an object with `no_contrast: true`
 * (bare or schema-valid). Anything else — a legacy single-proposal shape,
 * a non-object lens, a schema-invalid lens object, or an invariant
 * `trigger_signature` without the `general-` prefix — rejects the whole
 * reply (fail closed, same as today). Pure: throw sites are unit-covered.
 *
 * @param text - raw model output (one JSON object, fences tolerated).
 * @param completed - whether the motivating session completed (gates `prescribed` per lens).
 * @returns the two lens proposals, each null when declined.
 */
export function parseDualProposals(text: string, completed = true): DualEvaluatorProposals {
  const json = extractJsonObject(text)
  let reply: Record<string, unknown>
  try {
    reply = JSON.parse(json) as Record<string, unknown>
  } catch {
    throw new Error('session-meta: dual evaluator reply is not valid JSON')
  }
  if (typeof reply.intent === 'string') {
    throw new Error('session-meta: dual evaluator reply holds a single proposal, not invariant/domain lenses')
  }
  return {
    invariant: parseLens(reply.invariant, 'invariant', completed),
    domain: parseLens(reply.domain, 'domain', completed),
  }
}

/**
 * Validate one lens value: missing/null declines, an explicit
 * `no_contrast: true` object declines without further checks, any other
 * object must satisfy `parseProposal` (whose own `no_contrast` verdict also
 * declines). Non-object lens values reject the reply.
 */
function parseLens(value: unknown, lens: 'invariant' | 'domain', completed: boolean): EvaluatorProposal | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`session-meta: dual evaluator ${lens} lens must be an object or null`)
  }
  const record = value as Record<string, unknown>
  if (record.no_contrast === true) return null
  const proposal = parseProposal(JSON.stringify(record), completed)
  if (lens === 'invariant' && !proposal.triggerSignature.startsWith('general-')) {
    throw new Error('session-meta: dual evaluator invariant lens trigger_signature must start with general-')
  }
  return proposal
}

function isNonEmptyStringArray(value: unknown): value is readonly string[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(entry => typeof entry === 'string' && entry.trim() !== '')
  )
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every(entry => typeof entry === 'string')
}

/** Strip one fenced block if present; otherwise the trimmed raw text. */
function extractJsonObject(text: string): string {
  const trimmed = text.trim()
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n```\s*$/.exec(trimmed)
  const body = (fenced?.[1] ?? trimmed).trim()
  if (!body.startsWith('{') || !body.endsWith('}')) {
    throw new Error('session-meta: evaluator output must be a single JSON object')
  }
  return body
}

/**
 * Run one evaluator call: stream, assemble text-only output, and report
 * measured token usage (0/0 when the adapter omits usage — the call-count
 * cap still bounds spend). Parsing happens after; callers choose the
 * single-proposal or dual-lens shape.
 *
 * @param llm - model service streaming the evaluator reply.
 * @param route - resolved evaluator route and limits.
 * @param input - evaluator input (projection plus steering).
 * @param signal - optional caller cancellation.
 * @returns the raw reply text plus measured token usage.
 */
export async function collectEvaluatorReply(
  llm: EvaluatorLlm,
  route: EvaluatorRoute,
  input: EvaluatorInput,
  signal?: AbortSignal,
): Promise<EvaluatorReply> {
  const prompt = buildEvaluatorPrompt(input)
  if (Buffer.byteLength(prompt, 'utf8') > route.maxInputBytes) {
    throw new Error(`session-meta: evaluator input exceeds maxInputBytes ${route.maxInputBytes}`)
  }
  const messages: Message[] = [createUserMessage({
    content: [{ type: 'text', text: prompt }],
    source: sessionMetaSource(),
  })]
  const deadline = AbortSignal.timeout(route.timeoutMs)
  const combined = signal === undefined ? deadline : AbortSignal.any([signal, deadline])
  const assembler = new BlockAssembler()
  for await (const chunk of llm.stream({
    provider: route.provider,
    model: route.model,
    messages,
    system: EVALUATOR_SYSTEM,
    maxTokens: route.maxOutputTokens,
    signal: combined,
    sessionId: input.sessionId,
  })) {
    combined.throwIfAborted()
    assembler.push(chunk)
  }
  combined.throwIfAborted()
  const finish = assembler.finish as { kind?: unknown; failure?: unknown }
  if (typeof finish.kind === 'string' && (finish.kind === 'length' || finish.kind.includes('error'))) {
    throw new Error(`session-meta: evaluator call finished with ${finish.kind}: ${JSON.stringify(finish.failure ?? null).slice(0, 300)}`)
  }
  const blocks = assembler.blocks()
  if (blocks.some(block => block.type === 'tool-call')) {
    throw new Error('session-meta: evaluator output must contain text only')
  }
  const text = blocks
    .filter((block): block is Extract<typeof blocks[number], { type: 'text' }> => block.type === 'text')
    .map(block => block.text)
    .join(' ')
  if (text.trim() === '') {
    throw new Error('session-meta: evaluator produced no text')
  }
  const usage = assembler.usage
  return { text, inputTokens: usage?.inputTokens ?? 0, outputTokens: usage?.outputTokens ?? 0 }
}

/**
 * Run one evaluator call: stream, assemble text-only output, validate the
 * proposal, and report measured token usage (0/0 when the adapter omits
 * usage — the call-count cap still bounds spend).
 */
export async function runEvaluator(
  llm: EvaluatorLlm,
  route: EvaluatorRoute,
  input: EvaluatorInput,
  signal?: AbortSignal,
): Promise<EvaluatorResult> {
  const reply = await collectEvaluatorReply(llm, route, input, signal)
  return {
    proposal: parseProposal(reply.text, input.projection.completed),
    inputTokens: reply.inputTokens,
    outputTokens: reply.outputTokens,
  }
}

/**
 * Run one dual-lens evaluator call: stream, assemble text-only output,
 * validate both lens proposals, and report measured token usage (0/0 when
 * the adapter omits usage — the call-count cap still bounds spend).
 */
export async function runDualEvaluator(
  llm: EvaluatorLlm,
  route: EvaluatorRoute,
  input: EvaluatorInput,
  signal?: AbortSignal,
): Promise<DualEvaluatorResult> {
  const reply = await collectEvaluatorReply(llm, route, input, signal)
  const proposals = parseDualProposals(reply.text, input.projection.completed)
  return {
    invariant: proposals.invariant,
    domain: proposals.domain,
    inputTokens: reply.inputTokens,
    outputTokens: reply.outputTokens,
  }
}
