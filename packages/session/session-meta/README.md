---
description: "Redacted per-session aggregates, deterministic triage, and a SQLite meta store: the learning-loop input side for operators composing or debugging dsh-meta."
kind: "package-reference"
---

# @deepseek-ai/dsh-session-meta

English | [中文](README.zh.md)

## Summary

`dsh-session-meta` is the observe-only input side of the dsh-meta learning
loop (Plan-V1 M1). It taps the session firehose (`session/event`,
`session/flush`, `session/disposed`, `agent/error` — the telemetry
coordinator's capture pattern), scrubs secrets, folds one aggregate per
session, routes it deterministically (`track_a` / `track_b` / `no_op`), and
persists the row plus bounded evidence into `$DSH_HOME/meta/meta.db`. It
writes nothing to skills and mutates no loop state; promotion lives in M3.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount the plugin beside the session store in any profile whose sessions
should feed the learning loop. No other plugin is required — the tap reads
the event bus directly, so it works with any telemetry backend, or none.

### Composition

```yaml
- name: '@deepseek-ai/dsh-session'
- name: '@deepseek-ai/dsh-session-meta'
  config:
    dshHome: !!js process.env.DSH_HOME
```

For a one-off smoke run without touching a real home, pass an explicit
`dbPath` (tests use `:memory:`):

```yaml
- name: '@deepseek-ai/dsh-session-meta'
  config:
    dshHome: '/tmp/meta-smoke'
    dbPath: ':memory:'
```

### Config

| Field | Meaning |
|---|---|
| `dshHome` | Harness home. Required by the schema; the launcher supplies `process.env.DSH_HOME`. |
| `dbPath` | Absolute database path. Empty (default) resolves to `$DSH_HOME/meta/meta.db`. |
| `maxEvidencePerSession` | Evidence rows retained per session (errors + steering only). Default 200; overflow counts into `dropped_evidence`. |

### What the rows mean

`meta_sessions` holds one row per finalized session: identity (`id`, `cwd`,
`parent_session`, `origin`), counters (`events`, `tool_calls`,
`steering_events`, `feedback_events`, `assistant_messages`), JSON-encoded
`tool_errors` / `agent_errors` name lists, the last `turn_end_reason`, and the
triage verdict (`route`, `reasons`). `meta_evidence` holds up to
`maxEvidencePerSession` redacted diagnostic rows per session.

The M1 report primitive is SQL:

```sql
SELECT route, COUNT(*) FROM meta_sessions GROUP BY route;
```

### Triage routes

| Route | Trigger |
|---|---|
| `track_b` | Structural error (`SyntaxError`, `JSONParseError`, `ZodError`, `ERR_REGEX_TIMEOUT`, `ERR_TOOL_SCHEMA_VIOLATION`), any `agent/error`, any *unrecovered* tool error, or a non-`completed` turn end. |
| `track_a` | Human steering (a `user`-kind `user/message` after the first assistant message), or proven recovery: every failed step has a later succeeding same-tool step on a `completed` turn (`success-recovered`, with or without steering). |
| `no_op` | Neither signal. |

Result call ids are read from top-level `callId`, `message.callId`, `message.source.callId`, or content-block `toolCallId` (live `dsh-tool-result` shape); error names without step evidence still count, but never prove recovery.

Sessions whose every tool error is environment-class (`SandboxUnavailableError`, `MISSING_CREDENTIAL`) and which carry no structural or agent signal keep the `track_b` route and gain the `env-blocked` reason, so the environment share of the Track B corpus is countable without rerouting anything.

Inbox events whose message source is not human (`agent-message` relays, tool
frames, plugin notices) are never steering.

### Track A evaluator input (M2.1)

The projection the evaluator sees is grounded, not summarized: tool steps
carry redacted truncated call arguments (`args`, 500 chars) and failed-step
result digests (300 chars); failed steps mark recovery (`recovered` plus the
retry's `retryArgs`) when a later same-tool step succeeds; the payload names
consulted skills (`skillsConsulted`), the turn outcome (`completed`), and
already-proposed signatures (`known_signatures`, read from the skill root).
Proposals require `trigger_conditions`, rendered to the draft's `whenToUse`.
Non-completed sessions yield Forbidden-clauses only (never a prescribed
procedure for an unverified attempt). Prompt rules: procedure over narrative,
pitfall = rule + one clause of WHY, no incident identifiers, no tool-schema
duplication, no broken-tool claims.

The M2.2 effort gate spends evaluator calls where signal exists: trivial
sessions (few tool calls, early-only steering, no recovery) are skipped;
explicit persist requests ("remember this", "from now on", ...) always
evaluate. Knobs: `evaluator.minEvalToolCalls` (default 3),
`evaluator.earlySteeringMessages` (default 1). Passing drafts promote to live
immediately under a weekly blast cap (`evaluator.maxPromotionsPerWeek`, default 3).

<a id="understand-the-implementation"></a>
## Understand the implementation

Synchronous handlers only aggregate and buffer. SQLite writes happen on
`session/flush` and `session/disposed`, never on the event hot path. The
canonical session log is never rewritten — redaction applies to the meta
copy only (PEM blocks, known token prefixes, `key=value` secrets, `cwd` →
`$CWD`, home → `~`, per-string/array/depth bounds). On-disk schema is
versioned (`PRAGMA user_version = 3`); mismatches throw instead of migrating.

<details>
<summary>Developer section: module map</summary>

- `src/index.ts` — function plugin (`name`/`inject`/`Config`/`apply`, no default export): firehose tap, flush/dispose finalizers, store lifetime, plus `setReplayRunner` (host-registered L2/L3 replay runner; unset keeps skip-and-promote) and `settleSessionMeta` (test seam).
- `src/triage.ts` — pure deterministic router over `SessionAggregate`; every branch unit-tested without cordis.
- `src/projection.ts` — per-session state projection Σ (args, digests, recovery marks, consulted skills, outcome).
- `src/evaluator.ts` — budget-capped Flash call over Σ; schema-validated proposals.
- `src/judge.ts` — M3 L4-lite blinded order-swapped pairwise judge; harm veto only, fails closed.
- `src/replay.ts` — M3 L2/L3 replay-driver seam: outcome data, runner interface, scripted fake, harm veto, judge summary.
- `src/orchestrate.ts` — offline loop driver (budget, steering files, L0/L1 gates, L2 motivating-task replay gate, L3 regression-sample gate, gated drafts).
- `src/steering.ts` — headless correction-record ingest.
- `src/writer.ts` — gated `SKILL.md` drafts (`disable-model-invocation`, `whenToUse`).
- `src/l0.ts` — M3 L0 contract gate: deterministic veto over a rendered draft (frontmatter, metadata, sections, mechanizable bans); the orchestrator ledgers `l0-rejected` without writing.
 - `src/l1.ts` — M3 L1 self-test gate: a Prescribed clause is checkable when it names a session tool or quotes inline `code`; the orchestrator ledgers `l1-rejected` without writing.
- `src/redact.ts` — secret scrubbing and bounds.
- `src/store.ts` — `node:sqlite` meta store (`MetaStore`, `META_SCHEMA_VERSION`) plus the M3 skill registry (promotion lifecycle).
- `src/curator.ts` — M3 post-promotion lifecycle signals: per-session applied/confidence moves (silence-neutral) plus the 90-day decay sweep, wired from finalize.
- `src/trackb.ts` — M4 Track B reproduction emitter: parser-class crashes become characterization specs under `.dsh/reproductions/` (pass while the crash reproduces, fail if upstream ever accepts the payload), everything else lands in the `breakages.jsonl` upstream-PR register. The M4 spec runner executes each emitted spec once under the resolved Vitest binary and ledgers the exit code in `trackb_runs` (no curator hook reads it — invalidation stays reviewer-side until M5).
- `src/types.ts` — types only.

</details>

<a id="dev-note"></a>
## Dev Note

Coverage expectation is per-file 100%: `tests/redact.spec.ts`,
`tests/track-a-observers.spec.ts`, `tests/projection.spec.ts`,
`tests/evaluator.spec.ts`, `tests/orchestrate.spec.ts`, and
`tests/writer.spec.ts` pin every branch of the pure modules, and
`tests/loader-composition.spec.ts` boots the shipped YAML shape through the
vendored Loader and asserts durable rows (routes, redaction, evidence cap,
histogram) plus the no-default-export pin.

<a id="further-exploration"></a>
## Further Exploration

- Plan-V1 (SilverBullet `Projects/Self-Improving-Harness/Plan-V1`, outside this repo) — the in-repo contract is this README plus the test suite.
- Telemetry capture pattern: `../session-telemetry/src/coordinator.ts`.
- Skill frontmatter gate the loop will write through in M3: `../../skill/skill-filesystem/src/index.ts` (`disable-model-invocation`, `metadata:`).

<a id="model-experience"></a>
## Model Experience

### Request context and condition

#### What the model sees

Indirectly, through skills the M3 loop will write. This package contributes
no system-prompt sections, no tools, and no per-step context of its own.

#### Token effect

Zero-direct token effect.

#### KV Cache effect

Independent behavior. The plugin never mutates request context, tool
schemas, or system-prompt sections, so it cannot invalidate prefix reuse.
Provider cache availability and eviction remain outside the package contract.

<a id="known-limitations-and-deferred-work"></a>
## Known Limitations and Deferred Work

- **No query service yet** — the report surface is raw SQL against `meta.db`; a `ctx.meta` query API is deferred to M3+.
- **Feedback sentiment is unparsed** — `feedback/record` events count as engagement; Like/Dislike polarity is deferred to M3.
- **No generic high-entropy secret detection** — secrets without a key anchor or known prefix pass through; hashes and ids in tool arguments are preserved deliberately.
- **Evidence and projection are lossy by design** — only errors and steering are retained, capped per session; projection keeps 40 steps with truncated args/digests; full-trace replay stays in the canonical session log.
