/**
 * Track A evaluator (Plan-V1 §3.3): a budget-capped Flash call over the
 * state projection plus the steering record. Input = goal + Σ + steering;
 * output = schema-validated JSON proposal. Model output is proposal-only —
 * the writer persists it as a *gated* draft and (in M3) the L0–L4 pipeline
 * decides promotion. Pure helpers (prompt building, proposal parsing) stay
 * separate from the streaming call so every branch is unit-testable with a
 * fake `llm.stream`.
 */

import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Message, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { EvaluatorProposal, SessionProjection, SteeringRecord } from './types.ts'

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
  /** Existing draft signatures (cheap dedup hint; full merge is M3). */
  readonly knownSignatures?: readonly string[] | undefined
}

/** One evaluator run: the validated proposal plus measured usage. */
export interface EvaluatorResult {
  readonly proposal: EvaluatorProposal
  readonly inputTokens: number
  readonly outputTokens: number
}

const EVALUATOR_SYSTEM = [
  'You turn one session into a reusable skill draft.',
  'You receive a JSON state projection (goal, tool steps WITH the arguments the model actually passed, error digests, recovery marks, skills consulted, turn outcome, steering messages) plus the human correction, if any.',
  'Write the procedure that worked, not a narrative of the session:',
  'Ground every clause in the delta between the correction and the observed tool parameters: never invent tools, files, or commands absent from the projection.',
  'A pitfall is a generalizable rule plus one clause of WHY (the mechanism), imperative. Never paste error transcripts, PR numbers, dates, or session-specific identifiers as content.',
  'Do not duplicate what tool schemas already teach (parameter lists, syntax). Do not claim a tool or feature is broken — describe the working pattern instead.',
  'If a step failed and a later same-tool step succeeded (recovered: true), the lesson is the retry pattern (compare args with retryArgs), not the original failure.',
  'If completed is false, the session never verified a working method: write Forbidden-clauses only and leave prescribed empty. Never present an uncompleted attempt as a verified procedure.',
  'Prefer patching what exists: the skillsConsulted list names skills already covering this territory — aim trigger_signature at the one in play rather than inventing a parallel skill. The known_signatures list names drafts already proposed — do not re-propose them.',
  'Reply with exactly one JSON object, no fences, no prose, with keys: intent (one sentence), forbidden (array of strings, may be empty), prescribed (array of strings; non-empty when completed is true, empty when completed is false), trigger_signature (short kebab-case symptom tag), trigger_conditions (one or two sentences: when a future session should load this skill), platform (e.g. dsh-headless or unknown).',
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
 * with the required shape. `completed` gates the prescription rule (M2.2):
 * only a completed session may prescribe a procedure. Pure: throw sites
 * are all unit-covered.
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
  if (!isStringArray(proposal.prescribed) || (completed && proposal.prescribed.length === 0)) {
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
  return {
    intent: proposal.intent,
    forbidden: proposal.forbidden,
    prescribed: proposal.prescribed,
    triggerSignature: proposal.trigger_signature,
    triggerConditions: proposal.trigger_conditions,
    platform: proposal.platform,
  }
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
  const prompt = buildEvaluatorPrompt(input)
  if (Buffer.byteLength(prompt, 'utf8') > route.maxInputBytes) {
    throw new Error(`session-meta: evaluator input exceeds maxInputBytes ${route.maxInputBytes}`)
  }
  const messages: Message[] = [createUserMessage({
    content: [{ type: 'text', text: prompt }],
    source: { kind: 'plugin', plugin: 'dsh-session-meta' },
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
  return {
    proposal: parseProposal(text, input.projection.completed),
    inputTokens: usage?.inputTokens ?? 0,
    outputTokens: usage?.outputTokens ?? 0,
  }
}
