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
import { takeBudget } from './budget.ts'
import type { ObservedCall } from './types.ts'

/** Cordis plugin name. */
export const name = 'approval-gate'

/** No injections: the firehose and the waterfall are context-global. */
export const inject: readonly string[] = []

/** Live tool calls retained per answerer instance; beyond this the oldest drops. */
export const MAX_OBSERVED_CALLS = 500

/** Judge input command bound (the model justification rides verbatim). */
export const MAX_JUDGE_COMMAND_CHARS = 2000

/** Plugin configuration: home plus the judge route and budgets. No secrets here. */
export interface Config {
  /** Harness home holding the `meta` budget file. Required; fails loud when empty. */
  dshHome: string
  /** Chat-completions base URL for the judge. */
  judgeUrl?: string
  /** Judge model id on the wire. */
  judgeModel?: string
  /** Environment variable NAME holding the judge bearer key (resolved per request, never stored). */
  apiKeyEnv?: string
  /** Judge abort bound in millis. */
  timeoutMs?: number
  /** Judge calls allowed per UTC date. */
  maxCallsPerDay?: number
}

export const Config: z<Config> = z.object({
  dshHome: z.string(),
  judgeUrl: z.string().default('https://api.deepinfra.com/v1/openai'),
  judgeModel: z.string().default('deepseek-ai/DeepSeek-V4-Flash'),
  apiKeyEnv: z.string().default('DEEPINFRA_API_KEY'),
  timeoutMs: z.number().step(1).min(1).default(45000),
  maxCallsPerDay: z.number().step(1).min(1).default(50),
})

/** Resolved gate settings (from plugin config). */
export interface GateConfig {
  /** Harness home holding the `meta` budget file. */
  readonly dshHome: string
  /** Chat-completions base URL for the judge. */
  readonly judgeUrl: string
  /** Judge model id on the wire. */
  readonly judgeModel: string
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
  if (dshHome === '') throw new Error('approval-gate: config.dshHome is required (budget file home)')
  const apiKeyEnv = config.apiKeyEnv ?? 'DEEPINFRA_API_KEY'
  if (apiKeyEnv === '') throw new Error('approval-gate: config.apiKeyEnv must name the key variable')
  return {
    dshHome,
    judgeUrl: config.judgeUrl ?? 'https://api.deepinfra.com/v1/openai',
    judgeModel: config.judgeModel ?? 'deepseek-ai/DeepSeek-V4-Flash',
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
  /** Live tool calls by string call id: the ask payload carries none. */
  const calls = new Map<string, ObservedCall>()
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
      if (req.toolName !== 'bash') return next()
      const callId = typeof req.callId === 'string' ? req.callId : String(req.callId ?? '')
      const command = commandForCall(calls, callId)
      if (command === undefined) {
        ctx.logger.info(`approval-gate: delegating ${callId} (command unrecoverable)`)
        return next()
      }
      if (isBlacklisted(command)) {
        ctx.logger.info(`approval-gate: rejecting blacklisted command for ${callId}`)
        return 'rejected'
      }
      if (allowlisted(command)) {
        ctx.logger.info(`approval-gate: allowing allowlisted command for ${callId}`)
        return 'allowed-once'
      }
      const apiKey = process.env[resolved.apiKeyEnv] ?? ''
      if (apiKey === '') {
        ctx.logger.info(`approval-gate: delegating ${callId} (no ${resolved.apiKeyEnv})`)
        return next()
      }
      if (!(await takeBudget(resolved.dshHome, resolved.maxCallsPerDay))) {
        ctx.logger.info(`approval-gate: delegating ${callId} (judge budget spent)`)
        return next()
      }
      // Session and header exist by the service's own precondition (it read
      // session.seq before dispatch), so this read is total by construction.
      const header = (req.agent as unknown as { session: { header?: { cwd?: unknown } } }).session.header
      const cwd = typeof header?.cwd === 'string' ? header.cwd : ''
      const mode = /escalate sandbox to ([a-z-]+)/.exec(req.reason ?? '')?.[1] ?? 'unknown-mode'
      const verdict = await judgeCommand(
        { command: command.slice(0, MAX_JUDGE_COMMAND_CHARS), cwd, requestedMode: mode, justification: req.reason ?? '' },
        { url: resolved.judgeUrl, model: resolved.judgeModel, apiKey, timeoutMs: resolved.timeoutMs },
      )
      if (verdict === undefined) return next()
      ctx.logger.info(`approval-gate: judge ${verdict.verdict} for ${callId}: ${verdict.grounds}`)
      return verdict.verdict === 'allow' ? 'allowed-once' : 'rejected'
    } catch {
      return next()
    }
  })
}
