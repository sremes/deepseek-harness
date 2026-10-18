/**
 * Deterministic-first approval answerer (dogfood-hardened, fork-owned): a
 * waterfall listener on `approval/request` deciding sandbox-escalation asks
 * in three layers — exact-deny blacklist, narrow whole-command allowlist,
 * bounded LLM judge — and delegating everything else via `next()`.
 *
 * Degradation rule: the overlay's own failures (unresolvable command,
 * missing key, spent budget, judge fault) fall through to `next()`,
 * preserving pre-mount behavior exactly. Only the blacklist and an explicit
 * judge reject claim the request. The service appends the asked/decided
 * audit pair for every outcome either way.
 *
 * Accepted residual risk: the judge reads the model's own justification,
 * which shares the transcript with untrusted tool output. This gate beats
 * blanket full-access; it is not kernel confinement.
 *
 * @module @deepseek-ai/dsh-approval-gate
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-user-approval'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import { allowlisted, commandForCall, isBlacklisted } from './gate.ts'
import { judgeCommand } from './judge.ts'
import { jevVerdict } from './jev.ts'
import { takeBudget } from './budget.ts'
import { classifyCommand, recordDecision } from './ledger.ts'
import type { DelegateReason, DecisionLayer } from './ledger.ts'
import type { ObservedCall } from './types.ts'

/** Cordis plugin name. */
export const name = 'approval-gate'

/** No injections: the firehose and the waterfall are context-global. */
export const inject: readonly string[] = []

/** Live tool calls retained per answerer instance; beyond this the oldest drops. */
export const MAX_OBSERVED_CALLS = 500

/** Judge input command bound (the model justification rides verbatim). */
export const MAX_JUDGE_COMMAND_CHARS = 2000

/** Judge backend: a typed Jev decision or a raw generative-LLM verdict. */
export type JudgeBackend = 'jev' | 'llm'

/** Plugin configuration: home plus the judge route and budgets. No secrets here. */
export interface Config {
  /** Harness home holding the `meta` ledger and budget files. Required; fails loud when empty. */
  dshHome: string
  /** Which judge answers: Jev (default) or a generative LLM route. */
  judgeBackend?: JudgeBackend
  /** Jev System One endpoint URL (full path). */
  jevUrl?: string
  /** Jev model id: alias (`jev-preview`) or versioned pin (`jev-1.14.0`). */
  jevModel?: string
  /** Environment variable NAME holding the Jev bearer key (resolved per request, never stored). */
  jevKeyEnv?: string
  /** Jev `allow` below this top-probability delegates onward; `reject` is never softened. */
  escalateBelow?: number
  /** Judge base URL (no trailing path) for the `llm` backend. */
  judgeUrl?: string
  /** Judge model id on the wire for the `llm` backend. */
  judgeModel?: string
  /** Wire protocol: completions for chat-style endpoints, responses for the Go route. */
  api?: 'openai-completions' | 'openai-responses'
  /** Value sent as `x-opencode-session` on the responses protocol (routing hint). */
  sessionHeader?: string
  /** Environment variable NAME holding the judge bearer key (resolved per request, never stored). */
  apiKeyEnv?: string
  /** Judge abort bound in millis. */
  timeoutMs?: number
  /** Judge calls allowed per UTC date. */
  maxCallsPerDay?: number
}

export const Config: z<Config> = z.object({
  dshHome: z.string(),
  judgeBackend: z.union(['jev', 'llm'] as const).default('jev'),
  jevUrl: z.string().default('https://api.typesafe.ai/v1/systemone'),
  jevModel: z.string().default('jev-preview'),
  jevKeyEnv: z.string().default('TYPESAFE_KEY'),
  escalateBelow: z.number().min(0).max(1).default(0.6),
  judgeUrl: z.string().default('https://opencode.ai/zen/go/v1'),
  judgeModel: z.string().default('muse-spark-1.3-contributor'),
  api: z.union(['openai-completions', 'openai-responses'] as const).default('openai-responses'),
  sessionHeader: z.string().default('valjas-approval-gate'),
  apiKeyEnv: z.string().default('OPENCODE_GO_API_KEY'),
  timeoutMs: z.number().step(1).min(1).default(45000),
  maxCallsPerDay: z.number().step(1).min(1).default(50),
})

/** Resolved gate settings (from plugin config). */
export interface GateConfig {
  /** Harness home holding the `meta` ledger and budget files. */
  readonly dshHome: string
  /** Which judge answers. */
  readonly judgeBackend: JudgeBackend
  /** Jev System One endpoint URL (full path). */
  readonly jevUrl: string
  /** Jev model id. */
  readonly jevModel: string
  /** Environment variable NAME holding the Jev bearer key. */
  readonly jevKeyEnv: string
  /** Jev `allow` below this top-probability delegates onward. */
  readonly escalateBelow: number
  /** Judge base URL (no trailing path) for the `llm` backend. */
  readonly judgeUrl: string
  /** Judge model id on the wire for the `llm` backend. */
  readonly judgeModel: string
  /** Wire protocol the judge speaks. */
  readonly api: 'openai-completions' | 'openai-responses'
  /** Value sent as `x-opencode-session` on the responses protocol. */
  readonly sessionHeader: string
  /** Environment variable NAME holding the judge bearer key. */
  readonly apiKeyEnv: string
  /** Judge abort bound in millis. */
  readonly timeoutMs: number
  /** Judge calls allowed per UTC date. */
  readonly maxCallsPerDay: number
}

/**
 * Validate the raw config fail-closed: an empty home or key name is a
 * deployment error, never a silent default. Pure: unit-covered.
 *
 * @param config - raw plugin config.
 * @returns resolved settings.
 */
export function resolveGateConfig(config: Config): GateConfig {
  const dshHome = config.dshHome ?? ''
  if (dshHome === '') throw new Error('approval-gate: config.dshHome is required (ledger and budget file home)')
  const judgeBackend = config.judgeBackend ?? 'jev'
  if (judgeBackend !== 'jev' && judgeBackend !== 'llm') {
    throw new Error('approval-gate: config.judgeBackend must be jev or llm')
  }
  const apiKeyEnv = config.apiKeyEnv ?? 'OPENCODE_GO_API_KEY'
  if (apiKeyEnv === '') throw new Error('approval-gate: config.apiKeyEnv must name the key variable')
  const jevKeyEnv = config.jevKeyEnv ?? 'TYPESAFE_KEY'
  if (jevKeyEnv === '') throw new Error('approval-gate: config.jevKeyEnv must name the key variable')
  const escalateBelow = config.escalateBelow ?? 0.6
  if (!Number.isFinite(escalateBelow) || escalateBelow < 0 || escalateBelow > 1) {
    throw new Error('approval-gate: config.escalateBelow must be within 0..1')
  }
  const api = config.api ?? 'openai-responses'
  if (api !== 'openai-completions' && api !== 'openai-responses') {
    throw new Error('approval-gate: config.api must be openai-completions or openai-responses')
  }
  return {
    dshHome,
    judgeBackend,
    jevUrl: config.jevUrl ?? 'https://api.typesafe.ai/v1/systemone',
    jevModel: config.jevModel ?? 'jev-preview',
    jevKeyEnv,
    escalateBelow,
    judgeUrl: config.judgeUrl ?? 'https://opencode.ai/zen/go/v1',
    judgeModel: config.judgeModel ?? 'muse-spark-1.3-contributor',
    api,
    sessionHeader: config.sessionHeader ?? 'valjas-approval-gate',
    apiKeyEnv,
    timeoutMs: config.timeoutMs ?? 45000,
    maxCallsPerDay: config.maxCallsPerDay ?? 50,
  }
}

/**
 * Mount the firehose tap and the answerer. Fail-closed at load on a
 * missing home; every per-request fault degrades to `next()`.
 *
 * @param ctx - plugin context.
 * @param config - validated plugin config.
 */
export function apply(ctx: Context, config: Config): void {
  const resolved = resolveGateConfig(config)
  ctx.logger.info(
    `approval-gate: mounted (backend ${resolved.judgeBackend}, ` +
      (resolved.judgeBackend === 'jev'
        ? `jev ${resolved.jevModel}, escalate below ${String(resolved.escalateBelow)}`
        : `${resolved.judgeModel}, budget ${String(resolved.maxCallsPerDay)}/day`) +
      `, home ${resolved.dshHome})`,
  )
  /** Live tool calls by string call id: the ask payload carries none. */
  const calls = new Map<string, ObservedCall>()
  /** Delegate a waterfall ask onward and ledger the downstream outcome. */
  async function delegate(
    next: () => Promise<ApprovalOutcome>,
    reason: DelegateReason,
  ): Promise<ApprovalOutcome> {
    const outcome = await next()
    await recordDecision(resolved.dshHome, { layer: 'delegate', outcome, reason })
    return outcome
  }
  /** Record a claimed decision (never a delegation). */
  async function claim(
    layer: DecisionLayer,
    outcome: ApprovalOutcome,
    shape?: { bin: string; argc: number; metachars: boolean },
    extra?: { grounds?: string; judgeModel?: string; latencyMs?: number },
  ): Promise<void> {
    await recordDecision(resolved.dshHome, {
      layer,
      outcome,
      ...(shape ?? {}),
      ...(extra ?? {}),
    })
  }
  ctx.on('session/event', (_session, event) => {
    const data = (event as { type?: unknown; data?: unknown } | null)?.type === 'tool/call'
      ? (event as { data?: unknown }).data
      : undefined
    if (data === undefined) return
    const fields = (typeof data === 'object' && data !== null ? data : {}) as {
      callId?: unknown
      name?: unknown
      arguments?: unknown
    }
    const id = typeof fields.callId === 'string' && fields.callId !== '' ? fields.callId : undefined
    if (id === undefined) return
    // Bounded heuristic cache: past the cap, newest calls drop while the
    // early context (the session's own task calls) is retained.
    if (calls.size < MAX_OBSERVED_CALLS) {
      calls.set(id, { tool: fields.name, args: fields.arguments })
    }
  })
  ctx.on('approval/request', async (req, next): Promise<ApprovalOutcome> => {
    try {
      if (req.toolName !== 'bash') return delegate(next, 'non-bash')
      const callId = typeof req.callId === 'string' ? req.callId : String(req.callId ?? '')
      const command = commandForCall(calls, callId)
      if (command === undefined) {
        ctx.logger.info(`approval-gate: delegating ${callId} (command unrecoverable)`)
        return delegate(next, 'unrecoverable')
      }
      const shape = classifyCommand(command)
      if (isBlacklisted(command)) {
        ctx.logger.info(`approval-gate: rejecting blacklisted command for ${callId}`)
        await claim('blacklist', 'rejected', shape)
        return 'rejected'
      }
      if (allowlisted(command)) {
        ctx.logger.info(`approval-gate: allowing allowlisted command for ${callId}`)
        await claim('allowlist', 'allowed-once', shape)
        return 'allowed-once'
      }
      const apiKey = process.env[resolved.apiKeyEnv] ?? ''
      if (resolved.judgeBackend === 'jev') {
        const jevKey = process.env[resolved.jevKeyEnv] ?? ''
        if (jevKey === '') {
          ctx.logger.info(`approval-gate: delegating ${callId} (no ${resolved.jevKeyEnv})`)
          return delegate(next, 'no-key')
        }
        if (!(await takeBudget(resolved.dshHome, resolved.maxCallsPerDay))) {
          ctx.logger.info(`approval-gate: delegating ${callId} (judge budget spent)`)
          return delegate(next, 'budget-spent')
        }
        const header = (req.agent as unknown as { session: { header?: { cwd?: unknown } } }).session.header
        const cwd = typeof header?.cwd === 'string' ? header.cwd : ''
        const mode = /escalate sandbox to ([a-z-]+)/.exec(req.reason ?? '')?.[1] ?? 'unknown-mode'
        const verdict = await jevVerdict(
          { command: command.slice(0, MAX_JUDGE_COMMAND_CHARS), cwd, requestedMode: mode, justification: req.reason ?? '' },
          { url: resolved.jevUrl, model: resolved.jevModel, apiKey: jevKey, timeoutMs: resolved.timeoutMs },
        )
        if (verdict === undefined) return delegate(next, 'judge-fault')
        const detail =
          `jev ${verdict.choice} top=${verdict.top.toFixed(2)} conf=${verdict.confidence.toFixed(2)}`
        if (verdict.choice === 'reject') {
          ctx.logger.info(`approval-gate: jev reject for ${callId}: ${detail}`)
          await claim('judge', 'rejected', shape, { grounds: detail, judgeModel: verdict.model, latencyMs: verdict.latencyMs })
          return 'rejected'
        }
        if (verdict.top < resolved.escalateBelow) {
          ctx.logger.info(`approval-gate: jev uncertain for ${callId}: ${detail}`)
          await recordDecision(resolved.dshHome, {
            layer: 'judge', outcome: 'uncertain', grounds: detail, judgeModel: verdict.model, latencyMs: verdict.latencyMs, ...shape,
          })
          return delegate(next, 'uncertain')
        }
        ctx.logger.info(`approval-gate: jev allow for ${callId}: ${detail}`)
        await claim('judge', 'allowed-once', shape, { grounds: detail, judgeModel: verdict.model, latencyMs: verdict.latencyMs })
        return 'allowed-once'
      }
      if (apiKey === '') {
        ctx.logger.info(`approval-gate: delegating ${callId} (no ${resolved.apiKeyEnv})`)
        return delegate(next, 'no-key')
      }
      if (!(await takeBudget(resolved.dshHome, resolved.maxCallsPerDay))) {
        ctx.logger.info(`approval-gate: delegating ${callId} (judge budget spent)`)
        return delegate(next, 'budget-spent')
      }
      // Session and header exist by the service's own precondition (it read
      // session.seq before dispatch), so this read is total by construction.
      const header = (req.agent as unknown as { session: { header?: { cwd?: unknown } } }).session.header
      const cwd = typeof header?.cwd === 'string' ? header.cwd : ''
      const mode = /escalate sandbox to ([a-z-]+)/.exec(req.reason ?? '')?.[1] ?? 'unknown-mode'
      const started = Date.now()
      const verdict = await judgeCommand(
        { command: command.slice(0, MAX_JUDGE_COMMAND_CHARS), cwd, requestedMode: mode, justification: req.reason ?? '' },
        {
          url: resolved.judgeUrl,
          model: resolved.judgeModel,
          apiKey,
          api: resolved.api,
          headers: resolved.api === 'openai-responses' ? { 'x-opencode-session': resolved.sessionHeader } : undefined,
          timeoutMs: resolved.timeoutMs,
        },
      )
      const latencyMs = Date.now() - started
      if (verdict === undefined) return delegate(next, 'judge-fault')
      ctx.logger.info(`approval-gate: judge ${verdict.verdict} for ${callId}: ${verdict.grounds}`)
      const outcome = verdict.verdict === 'allow' ? 'allowed-once' : 'rejected'
      await claim('judge', outcome, shape, { grounds: verdict.grounds, judgeModel: resolved.judgeModel, latencyMs })
      return outcome
    } catch {
      return delegate(next, 'exception')
    }
  })
}
