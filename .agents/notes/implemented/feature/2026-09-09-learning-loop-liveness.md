# Agent Note: Learning-loop liveness (affinity, dedup, drain)

Status: implemented

No active note owns evaluation delivery: the M2/M3 notes own gates and lifecycle, but all assumed evaluations complete. They did not, in headless or any flush-per-batch host.

## Problem

Three stacked faults kept every post-M2 evaluation from completing: the evaluator route failed instantly (Spark thinking shares `maxTokens`; the 2000 cap ended every call with zero tokens — fix is config `maxOutputTokens: 32000`, verified by probe); evaluator calls carried no session id so the relay drops them (`MissingSessionID` — fix is `EvaluatorInput.sessionId` plumbed to `llm.stream`); the headless runner called `io.exit` with zero drain so slow real calls died with the process while instant failures ledgered (survivorship bias toward failure rows); and every flush queued a duplicate evaluation (hundreds banked against the daily budget).

## Decision

`EvaluatorInput` gains `sessionId` (affinity key only, never prompt content — session ids in prompts stay banned). `finalizeSession` dedupes Track A evaluations per session id (flush fires per batch; evaluation runs once). `session-meta` provides a `sessionMeta` settle handle and the headless runner awaits it after flush before exit (absent providers change nothing; string-keyed, no imports either way). Evaluator finish failures now include the provider payload (the swallowed `finished with error` cost a day of diagnosis).

## Alternatives considered

**Flash evaluator route.** Rejected for now: it sidesteps the Spark faults without fixing them, and every worker-adjacent call should exercise the same route the workers use. Revisit if Spark pricing or reliability regresses.

**Drain via `appExit` hooks.** Rejected: `appExit` is a bare exit function with no hook surface; the optional settle handle needs no host changes.

**Budget-window dedup.** Rejected: the daily budget counts attempts including failures, so a failure storm permanently blocks the day. In-memory per-session dedup is the correct layer; budget stays spend control.

## Consequences

Headless runs grow by the evaluation tail (one model call plus possible replays) — correct for one-shot completeness. Vetoed drafts still leak their directories (L0/L1 veto without `rmSync`); 194 junk dirs archived, cleanup fix queued. Failure storms now ledger exactly one row per session instead of hundreds.

## Verification

- 347 tests green including once-per-session across repeated flushes, sessionId pass-through, drain ordering both sides, and a Track B live wire (finalize → emit → run → ledger).
- Live: `l0-rejected` rows (evaluations completing, weak drafts vetoed), `track_a / steering:1` sessions, per-file 100% coverage held, `tsc` builds clean.
