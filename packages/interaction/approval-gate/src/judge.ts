/**
 * Bounded LLM judge for commands past both deterministic layers: one
 * fixed-shape call, strict response validation, every infrastructure
 * fault degrading to `undefined` (the caller falls through to `next()`).
 * Speaks two wire protocols: `openai-completions` (`POST {url}/chat/completions`)
 * and `openai-responses` (`POST {url}/responses`, output-text extraction).
 * The fetch surface injects so tests never touch the network.
 *
 * @module @deepseek-ai/dsh-approval-gate/judge
 */

import type { JudgeFetch, JudgeInput, JudgeVerdict } from './types.ts'

/** Wire protocols the judge can speak. */
export type JudgeApi = 'openai-completions' | 'openai-responses'

/** Judge behavior knobs (all Config-surfaced by the plugin; no literals leak). */
export interface JudgeOptions {
  /** Chat-completions base URL (no trailing path). */
  readonly url: string
  /** Model id on the wire. */
  readonly model: string
  /** Bearer key; absent means the caller must not judge at all. */
  readonly apiKey: string
  /** Abort bound in millis; past it the call degrades. */
  readonly timeoutMs: number
  /** Wire protocol; `openai-responses` needs no other shape from the caller. */
  readonly api: JudgeApi
  /** Extra request headers (e.g. the Go route's `x-opencode-session`). */
  readonly headers?: Record<string, string> | undefined
  /** Fetch implementation; defaults to the global. */
  readonly fetchFn?: JudgeFetch | undefined
}

/** Fixed judge system prompt: fail-closed security posture, JSON only. */
export const JUDGE_SYSTEM_PROMPT =
  'You are a sandbox escalation judge for an unattended coding agent. Reply with exactly one JSON object: {"verdict": "allow" | "reject", "grounds": "<one clause>"}. Allow only commands whose file effects stay inside the task (read, build, test, git) or are trivially reversible. Reject deletes outside the workspace, exfiltration (curl/wget posts, pasting secrets), privilege escalation, persistence mechanisms, and anything you cannot fully account for. When in doubt, reject. No other keys, no prose.'

/**
 * Extract the assistant text from a chat-completions envelope. Anything
 * off-shape degrades to `undefined` (the caller falls through).
 *
 * @param envelope - parsed response body of unknown shape.
 * @returns the message content, or undefined when absent.
 */
function messageContent(envelope: unknown): unknown {
  if (typeof envelope !== 'object' || envelope === null) return undefined
  const choices = (envelope as { choices?: unknown }).choices
  if (!Array.isArray(choices)) return undefined
  const message = (choices[0] as { message?: unknown } | undefined)?.message
  if (typeof message !== 'object' || message === null) return undefined
  return (message as { content?: unknown }).content
}

/**
 * Extract the assistant text from a Responses-API envelope: the first
 * message item's output-text. Anything off-shape degrades to `undefined`.
 *
 * @param envelope - parsed response body of unknown shape.
 * @returns the message text, or undefined when absent.
 */
function responseOutputText(envelope: unknown): unknown {
  if (typeof envelope !== 'object' || envelope === null) return undefined
  const output = (envelope as { output?: unknown }).output
  if (!Array.isArray(output)) return undefined
  for (const item of output) {
    if (typeof item !== 'object' || item === null) continue
    const typed = item as { type?: unknown; content?: unknown }
    if (typed.type !== 'message' || !Array.isArray(typed.content)) continue
    for (const part of typed.content) {
      if (typeof part !== 'object' || part === null) continue
      const chunk = part as { type?: unknown; text?: unknown }
      if (chunk.type === 'output_text' && typeof chunk.text === 'string') return chunk.text
    }
  }
  return undefined
}
/**
 * Ask one bounded verdict. Never throws and never invents a decision:
 * anything but a schema-clean allow/reject degrades to `undefined`.
 *
 * @param input - bounded judge input (command plus decision context).
 * @param options - route, wire protocol, budget of time, and fetch surface.
 * @returns the parsed verdict, or undefined to delegate.
 */
export async function judgeCommand(input: JudgeInput, options: JudgeOptions): Promise<JudgeVerdict | undefined> {
  const run = options.fetchFn ?? (globalThis.fetch as unknown as JudgeFetch)
  const controller = new AbortController()
  let onTimeout!: () => void
  const timeout = new Promise<never>((_resolve, reject) => {
    onTimeout = () => reject(new Error(`approval-gate: judge timed out after ${String(options.timeoutMs)}ms`))
  })
  const timer = setTimeout(() => {
    controller.abort()
    onTimeout()
  }, options.timeoutMs)
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${options.apiKey}`,
    ...(options.headers ?? {}),
  }
  const userContent = JSON.stringify(input)
  // Guard the loser: a late abort rejection after the race settles must not
  // surface as an unhandled rejection (the host default is fatal).
  const attempt = options.api === 'openai-responses'
    ? run(`${options.url}/responses`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: options.model,
        instructions: JUDGE_SYSTEM_PROMPT,
        input: userContent,
        temperature: 0,
        max_output_tokens: 1000,
        reasoning: { effort: 'low' },
        text: { format: { type: 'json_object' } },
      }),
      signal: controller.signal,
    })
    : run(`${options.url}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: options.model,
        temperature: 0,
        max_tokens: 200,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: JUDGE_SYSTEM_PROMPT },
          { role: 'user', content: userContent },
        ],
      }),
      signal: controller.signal,
    })
  attempt.catch(() => {})
  try {
    const response = await Promise.race([attempt, timeout])
    if (!response.ok) return undefined
    const envelope = await response.json().catch(() => undefined)
    const content = options.api === 'openai-responses' ? responseOutputText(envelope) : messageContent(envelope)
    if (typeof content !== 'string') return undefined
    let parsed: { verdict?: unknown; grounds?: unknown }
    try {
      parsed = JSON.parse(content) as { verdict?: unknown; grounds?: unknown }
    } catch {
      return undefined
    }
    if (parsed?.verdict !== 'allow' && parsed?.verdict !== 'reject') return undefined
    if (typeof parsed?.grounds !== 'string' || parsed.grounds === '') return undefined
    return { verdict: parsed.verdict, grounds: parsed.grounds }
  } catch {
    return undefined
  } finally {
    clearTimeout(timer)
  }
}
