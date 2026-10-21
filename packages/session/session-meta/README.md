---
description: "Redacted per-session aggregates, deterministic triage, and a SQLite meta store: the input side of the dsh-meta learning loop for operators composing or debugging it."
kind: "package-reference"
---

# @deepseek-ai/dsh-session-meta

## Summary

`dsh-session-meta` watches every session and files one summary row per session into `$DSH_HOME/meta/meta.db`. It sorts sessions into three piles — `track_a` (something to learn: a recovery, a human correction), `track_b` (a crash or bug to reproduce), `no_op` (nothing to learn) — and, once you point it at a model, turns `track_a` sessions into tested skill drafts through a gated pipeline. It never rewrites the session log and never edits skills itself; a draft goes live only after passing every gate below.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Design influences](#design-influences)
- [Further Exploration](#further-exploration)
- [Dev Note](#dev-note)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

## Use this package

Mount the plugin beside the session store in any profile whose sessions should feed the learning loop. No other plugin is required — the tap reads the event bus directly, so it works with any telemetry backend, or none.

### Composition

```yaml
- name: '@deepseek-ai/dsh-session'
- name: '@deepseek-ai/dsh-session-meta'
  config:
    dshHome: !!js process.env.DSH_HOME
```

For a one-off smoke run without touching a real home, pass an explicit `dbPath` (tests use `:memory:`):

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
| `skillsDir` | Where skill drafts and live skills live. Default `$DSH_HOME/skills`. |
| `driveOnBoot` | Run one post-hoc steering drive on the first finalize. Default `false`; set `true` only on background hosts (see below). |
| `evaluator` | The model route that proposes skills. Disabled unless `enabled` is `true` with an explicit `provider` and `model`; everything else falls back to defaults. Knobs: `maxInputBytes` (12000), `maxOutputTokens` (2000 — thinking models need far more; 32000 is verified for Spark), `timeoutMs` (120000), `maxCallsPerDay` (1), `maxReplaysPerDay` (8), `minEvalToolCalls` (3), `earlySteeringMessages` (1), `maxPromotionsPerWeek` (3). |

### What the rows mean

`meta_sessions` holds one row per finalized session: identity (`id`, `cwd`, `parent_session`, `origin`), counters (`events`, `tool_calls`, `steering_events`, `feedback_events`, `assistant_messages`), JSON-encoded `tool_errors` / `agent_errors` name lists, the last `turn_end_reason`, and the triage verdict (`route`, `reasons`). `meta_evidence` holds up to `maxEvidencePerSession` redacted diagnostic rows per session.

The route report is one SQL query:

```sql
SELECT route, COUNT(*) FROM meta_sessions GROUP BY route;
```

### Triage routes

| Route | Trigger |
|---|---|
| `track_b` | Structural error (`SyntaxError`, `JSONParseError`, `ZodError`, `ERR_REGEX_TIMEOUT`, `ERR_TOOL_SCHEMA_VIOLATION`), any `agent/error`, any *unrecovered* tool error, or a non-`completed` turn end. |
| `track_a` | Human steering (a `user`-kind `user/message` after the first assistant message), proven recovery: every failed step has a later succeeding same-tool step on a `completed` turn, or an approval-outcome signal (see below). |
| `no_op` | Neither signal. |

Result call ids are read from top-level `callId`, `message.callId`, `message.source.callId`, or content-block `toolCallId` (the live `dsh-tool-result` shape); error names without step evidence still count, but never prove recovery.

Sessions whose every tool error is environment-class (`SandboxUnavailableError`, `MISSING_CREDENTIAL`) and which carry no structural or agent signal keep the `track_b` route and gain the `env-blocked` reason, so the environment share of the Track B corpus is countable without rerouting anything.

Inbox events whose message source is not human (`agent-message` relays, tool frames, plugin notices) are never steering.

### Approval-outcome signals

When the approval gate answered prompts in a session, the finalize step joins the session's observed tool-call ids against that gate's decision ledger (`$DSH_HOME/meta/approver-decisions.jsonl`, exact `callId` match, session-window only). Divergences become triage reasons and upgrade a signal-less session to `track_a` — structural routes keep their verdict and gain the reason:

| Signal | Meaning | Reason |
|---|---|---|
| `override-allow` | Gate rejected, human allowed | `approval-override-allow:<bin>` — criteria too strict; strongest correction |
| `override-deny` | Gate allowed, human rejected | `approval-override-deny:<bin>` — gate too permissive |
| `uncertain-allowed` / `uncertain-confirmed` | Judge unsure, human decided | `approval-uncertain-*:<bin>` — calibration data for `escalateBelow` |

A missing or unreadable ledger yields no signals. Lapses (nobody decided) are never session-attached — friction data, not correction. The blacklist/allowlist stay hand-owned: signals may tune the judge's criteria and thresholds, never the deterministic layers.

### What the evaluator sees

The projection the evaluator reads is grounded, not summarized: tool steps carry redacted truncated call arguments (`args`, 500 chars) and failed-step result digests (300 chars); failed steps mark recovery (`recovered` plus the retry's `retryArgs`) when a later same-tool step succeeds; the payload names consulted skills (`skillsConsulted`), the turn outcome (`completed`), and already-proposed signatures (`known_signatures`, read from the skill root). Proposals require `trigger_conditions`, rendered to the draft's `whenToUse`. Non-completed sessions yield Forbidden-clauses only (never a prescribed procedure for an unverified attempt). Prompt rules: procedure over narrative, pitfall = rule + one clause of WHY, no incident identifiers, no tool-schema duplication, no broken-tool claims. The prompt works in three explicit phases — (a) reference behavior from the steps, (b) corrected behavior from the steering, (c) the tool/argument/order contrast the prescription rests on. Every prescribed/forbidden clause cites its grounding in required `evidence` (one step/tool-call citation per clause, e.g. `step 4: retryArgs added --flag`); when the correction restates what the session already did, the proposal declines prescription with empty `prescribed` plus `no_contrast: true` (nothing observable to teach).

The evaluator emits two lenses in one call: an invariant lens (cross-domain agentic deficiency — planning, tool use, delegation, verification habits; `trigger_signature` starts with `general-`) and a domain lens (task-specific procedure/constraints). The reply is one JSON object with keys `invariant` and `domain`; each holds a proposal with the schema above and its own `evidence` array (a citation supporting clauses in both lenses must appear in each array to count there), or `null` when that lens has no content. A lens object with `no_contrast: true` counts as declined, like `null`; missing keys count as declined. Anything else rejects the whole reply fail-closed.

Each non-declined lens runs the validation pipeline below independently, domain first; each declined lens ledgers `declined:no-contrast`. Token accounting records the real call usage on the domain (first-processed) row and 0/0 on the invariant row, so the pair sums to one call and never double-counts spend. Existing caps bind the pair: one evaluator call per day, a shared replay budget (a spent budget skips the second lens's replay), and two promotions from one session count as two. The wrapper keeps `{decision, draftSlug}` plus a `drafts` array with the per-lens outcomes in processing order: both declined behaves like the single decline; at least one promotion yields `promoted` with the first promoted slug; otherwise the domain (first) lens decision with a null slug.

### The validation pipeline

The effort gate spends evaluator calls where signal exists: trivial sessions (few tool calls, early-only steering, no recovery) are skipped; explicit persist requests ("remember this", "from now on", ...) always evaluate. Passing drafts promote to live immediately under a weekly blast cap (`maxPromotionsPerWeek`, default 3).

In order, per lens:

1. **Contract check.** The rendered draft must parse: frontmatter with non-empty `cue`/`lesson`/`evidence`, real Forbidden/Prescribed clauses, mechanizable bans (no session-specific identifiers, no negative-capability claims). A veto ledgers `l0-rejected` and writes nothing.
2. **Self-test.** A Prescribed clause is checkable when it names a session tool or quotes inline `code`. A veto ledgers `l1-rejected` and writes nothing.
3. **Replay.** The originating task runs twice — with the draft mounted and without it. A harm comparison plus a blinded pairwise judge must prefer the candidate; any baseline preference vetoes. Without a registered replay runner, or with a spent replay budget, this step skips and promotion proceeds.
4. **Regression sample.** The same A/B shape replays up to 3 past sessions under the same trigger signature. Same skip rules as replay.
5. **Pairwise judge (backing steps 3–4).** The judge compares candidate vs baseline runs with the order hidden (harm veto only, never proof of gain): any preference for the baseline on either run vetoes, split verdicts veto, and unparseable output fails closed.

A retired trigger signature short-circuits the pipeline: a proposal under an invalidated signature is declined after the evaluator reply and before the contract check with decision `invalidated:<reason-slug>` — no draft is written and no further spend follows. This is distinct from `declined:no-contrast` (nothing to learn): invalidation means learned, then superseded.

A draft that passes the pipeline under an EXISTING `trigger_signature` composes instead of replacing: the incumbent skill file keeps its slug while its Forbidden/Prescribed sections union with the incoming draft (exact-trimmed-match dedupe only — near-dupes are kept as distinct clauses, no similarity matching). Additive composition never re-probations earned trust: the registry row keeps its slug, confidence, status, and `applied_count`. Each newly added clause records one `clause_evidence` row; the verdict is `isolated` only when the promoting draft carried exactly one clause total, otherwise `confounded` (the default, preferred over invented attribution). The composition ledgers `composed:<added-count>` with the kept slug, plus a promotions-table row so composed promotions trip the same weekly blast-cap counter as replacing ones.

### Operating the loop

Records written after their session exited are not lost: `drivePendingSteering` (post-hoc driver) runs pending `meta/steering/*.json` files through the same gates and the same evaluation — the explicit file bypasses the route gate but keeps the effort gate. Finalized aggregates persist in `meta_aggregates` so the driver reads post-exit state; consumed records move to `processed/`, transient states (no aggregate yet, LLM failure, spent budget) stay pending for the next drive.

Set `driveOnBoot: true` only on background hosts (the nightly cron headless profile): the first finalized session queues one drive through the shared settle drain one-shot hosts await. Shipped profiles and interactive hosts leave it `false` (default).

Teach after the fact by dropping a correction note as JSON into `$DSH_HOME/meta/steering/` ("from now on, always …"). Retire a skill the world has outgrown with a drop-in record: `$DSH_HOME/meta/invalidate/<trigger-signature>.json` with `{reason: <non-empty string>}`. Every finalize drains the directory: valid records ledger the invalidation (live/probation rows archive at the confidence floor and their skill directory is removed) and move to `processed/`; invalid JSON and invalid records move to `processed/` with a `.bad` suffix and a log line, mirroring the steering-file error handling.

Progress is one function call — `MetaStore.getStats()`:

```json
{
  "sessionsByRoute": { "track_a": 12, "track_b": 3, "no_op": 40 },
  "evaluationsByDecision": { "promoted": 2, "l0-rejected": 1 },
  "promotionsByWeek": 2,
  "replayRunsByDay": 4,
  "invalidations": 1
}
```

`promotionsByWeek` covers the trailing 7 days, `replayRunsByDay` the trailing 24 hours. The boot drive logs one `session-meta: stats ...` info line with this snapshot — the nightly/background entry point both profiles share, never per session. This is the cost telemetry: invocation counts times known per-call cost beat an unverifiable dollar estimate.

## Understand the implementation

Synchronous handlers only aggregate and buffer. SQLite writes happen on `session/flush` and `session/disposed`, never on the event hot path. The canonical session log is never rewritten — redaction applies to the meta copy only (PEM blocks, known token prefixes, `key=value` secrets, `cwd` → `$CWD`, home → `~`, per-string/array/depth bounds). On-disk schema is versioned (`PRAGMA user_version = 10`); older versions migrate forward, anything else throws instead of migrating.

<details>
<summary>Developer section: module map</summary>

- `src/index.ts` — function plugin (`name`/`inject`/`Config`/`apply`, no default export): firehose tap, flush/dispose finalizers, store lifetime, plus `setReplayRunner` (host-registered replay runner; unset keeps skip-and-promote) and `settleSessionMeta` (test seam).
- `src/triage.ts` — pure deterministic router over `SessionAggregate`; every branch unit-tested without cordis.
- `src/projection.ts` — per-session state projection Σ (args, digests, recovery marks, consulted skills, outcome).
- `src/evaluator.ts` — budget-capped model call over Σ; schema-validated proposals.
- `src/judge.ts` — blinded order-swapped pairwise judge; harm veto only, fails closed.
- `src/replay.ts` — replay seam: outcome data, runner interface, scripted fake, harm veto, judge summary.
- `src/orchestrate.ts` — offline loop driver (budget, steering files, invalidation drop-ins, effort gate, contract/self-test gates, replay and regression gates, gated drafts, signature-collision composition, invalidated-signature pre-check).
- `src/compose.ts` — selective per-clause composition: incumbent-clause union with exact-trimmed-match dedupe plus confounded-preferring per-clause evidence.
- `src/driver.ts` — post-hoc steering driver: pending records through the same pipeline after session exit.
- `src/steering.ts` — headless correction-record ingest.
- `src/writer.ts` — gated `SKILL.md` drafts (`disable-model-invocation`, `whenToUse`). Draft metadata carries the draft's source record (cue/lesson/evidence in the shape of Harness²'s EXPERIENCE.md entries) derived only from the proposal plus the source arg: `cue` is the proposal's `triggerConditions` verbatim, `lesson` is the proposal's `intent` verbatim, and `evidence` is the proposal's `evidence` entries plus one `session:<id>` entry per source session, JSON-encoded. Composition rewrites clauses only, so these keys survive it byte-identical.
- `src/l0.ts` — contract gate: deterministic veto over a rendered draft (frontmatter, metadata including non-empty `cue`/`lesson`/`evidence`, sections, mechanizable bans); the orchestrator ledgers `l0-rejected` without writing.
- `src/l1.ts` — self-test gate: a Prescribed clause is checkable when it names a session tool or quotes inline `code`; the orchestrator ledgers `l1-rejected` without writing.
- `src/redact.ts` — secret scrubbing and bounds.
- `src/store.ts` — `node:sqlite` meta store (`MetaStore`, `META_SCHEMA_VERSION`) plus the skill registry (promotion lifecycle), `clause_evidence` (per-clause composition verdicts), `invalidations` (retired trigger signatures), and `getStats()` (route/decision/promotion/replay/invalidation counts).
- `src/curator.ts` — post-promotion lifecycle signals: per-session applied/confidence moves (silence-neutral) plus the 90-day decay sweep, wired from finalize.
- `src/trackb.ts` — Track B reproduction emitter: parser-class crashes become characterization specs under `.dsh/reproductions/` (pass while the crash reproduces, fail if upstream ever accepts the payload), everything else lands in the `breakages.jsonl` upstream-PR register. The spec runner executes each emitted spec once under the resolved Vitest binary and ledgers the exit code in `trackb_runs` (no curator hook reads it — invalidation stays reviewer-side).
- `src/types.ts` — types only.

</details>

## Design influences

Two published systems shaped this loop. [AutoSaddler](https://arxiv.org/abs/2608.23041) (Microsoft Research) showed that agent harnesses improve through an offline loop of diagnosing failed traces, proposing structured patches, and keeping only changes that generalize — our triage, constrained skill drafts, and replay-gated promotion follow that shape. [Harness²](https://arxiv.org/abs/2610.14224) (Google) showed that proposing two scoped variants per lesson — one cross-domain, one domain-specific — plus per-edit composition and a strict decline-when-evidence-is-thin rule beats single-shot proposals — our invariant/domain lenses, per-clause composition, and no-contrast declines follow that shape.

## Further Exploration

- Telemetry capture pattern: the coordinator the firehose tap mirrors is [`../session-telemetry/src/coordinator.ts`](../session-telemetry/src/coordinator.ts).
- Skill frontmatter the loop writes through: [`../../skill/skill-filesystem/src/index.ts`](../../skill/skill-filesystem/src/index.ts) (`disable-model-invocation`, `metadata:`).
- Replay runner the gates call: [`../session-meta-replay/README.md`](../session-meta-replay/README.md).
- Session group map: [`../README.md`](../README.md) — adjacent persistence, projection, title, and telemetry packages.

## Dev Note

Coverage expectation is per-file 100%: `tests/redact.spec.ts`, `tests/track-a-observers.spec.ts`, `tests/projection.spec.ts`, `tests/evaluator.spec.ts`, `tests/orchestrate.spec.ts`, and `tests/writer.spec.ts` pin every branch of the pure modules, and `tests/loader-composition.spec.ts` boots the shipped YAML shape through the vendored Loader and asserts durable rows (routes, redaction, evidence cap, histogram) plus the no-default-export pin.

## Model Experience

Indirectly, through the skill drafts the loop promotes, which the model reads as ordinary skills through the skill tool.

#### KV Cache effect

Skill files are static text between promotions, so request prefixes that include them stay reusable; a new promotion changes the text and starts a new reusable prefix.

## Known Limitations and Deferred Work

- **No query service yet** — the report surface is raw SQL against `meta.db`; a `ctx.meta` query API is planned but not built.
- **Feedback sentiment is unparsed** — `feedback/record` events count as engagement; Like/Dislike polarity is deferred.
- **No generic high-entropy secret detection** — secrets without a key anchor or known prefix pass through; hashes and ids in tool arguments are preserved deliberately.
- **Evidence and projection are lossy by design** — only errors and steering are retained, capped per session; projection keeps 40 steps with truncated args/digests; full-trace replay stays in the canonical session log.
