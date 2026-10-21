---
description: "SDK-backed replay driver for the learning loop: RunResult-to-outcome mapping plus the candidate/baseline replay runner for operators composing or debugging the replay validation gates."
kind: "package-reference"
---

# @deepseek-ai/dsh-session-meta-replay

## Summary

`dsh-session-meta-replay` test-runs a proposed skill before it goes live. It turns one owned SDK activity interval into a `ReplayOutcome` record (did the run complete, how much steering, how many tool calls) and drives two replays of a task — candidate (with the skill mounted) and baseline (without it) — over an injected run function. The evaluation pipeline in `@deepseek-ai/dsh-session-meta` receives the runner and calls it during the replay gates; this package never imports `sdk-client`, `dsh-session`, or `dsh-llm` at runtime, so the session-meta dependency rule holds by construction.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Dev Note](#dev-note)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

## Use this package

Construct `SdkReplayRunner` around a narrow run function and hand it to the evaluation dependencies. `DeepSeekHarness` satisfies the delegate shape structurally — no import — because its `run` accepts a wider input and a `RunOptions` supertype of these options while its `RunResult` carries both result fields.

```ts
import { SdkReplayRunner } from '@deepseek-ai/dsh-session-meta-replay'

const runner = new SdkReplayRunner(harness)
const candidate = await runner.run(taskInput, { skillOverlay: draft.dir })
const baseline = await runner.run(taskInput)
```

### Arm semantics

| Call | Arm | Delegate receives |
|---|---|---|
| `run(input)` or `run(input, { sessionId })` | Baseline | The input plus the session id; no overlay key at all |
| `run(input, { skillOverlay })` | Candidate | The input plus the overlay (mapped through `writePatch` when one is configured) |

The optional `writePatch` hook converts a candidate overlay directory into the overlay value the delegate receives. The default passes the directory through unchanged; `generateSkillOverlayPatch` (see `src/patch.ts`) renders a `--patch` file mounting the overlay as the `skill-filesystem` `customSkillDirs` instead.

### Outcome mapping

`mapRunResultToOutcome(events, finalResponse)` folds one interval: `completed` is true only when the last `turn/end` reason has the `completed` kind (the same completion definition `isCompletedTurnEnd` uses in session-meta's `projection.ts`); `turnEnd` is that reason's kind verbatim, or null when no turn ended. `steeringCount` counts human (`user`-kind) `user/message` events after the first `assistant/message` — the same rule `triage.ts` uses, so the opening prompt never counts and relays, tool frames, and plugin notices never count. `toolCalls` counts `tool/call` events. `summary` is the final response truncated to `REPLAY_SUMMARY_MAX_CHARS` (2000 chars).

-----

## Understand the implementation

The runner lives in this sibling package — not in `dsh-session-meta` — because session-meta keeps a minimal runtime dependency set (only `@deepseek-ai/schemastery`) and must never import `sdk-client`, `dsh-session`, or `dsh-llm` at runtime. The runner needs `SessionEvent` (a type-only import, erased at build) and a run function shaped like `DeepSeekHarness.run`; keeping both behind this package's boundary leaves session-meta's runtime closure untouched while the pipeline keeps receiving the runner through the existing optional `EvaluationDeps.replayRunner` field. The host composition owns construction and registers the runner once at boot via `setReplayRunner`; without registration, the replay gates keep their skip-and-promote behavior.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Package entry: re-exports the seam, mapping, and runner |
| [`src/types.ts`](src/types.ts) | Type-only seam: outcome, run options/result, narrow run function, runner options |
| [`src/outcome.ts`](src/outcome.ts) | Pure interval-to-outcome fold plus the summary bound |
| [`src/runner.ts`](src/runner.ts) | `SdkReplayRunner`: arm routing over the injected delegate plus mapping |
| — | No runtime invariant companion is published: the package owns a pure fold and a thin routing class with no independent observable state to compare against; completion ordering is owned by the session loop and the SDK runtime. |

-----

## Further Exploration

Read these pages when the package contract is not enough. They move from the replay seam to the pipeline that consumes it and the runtime that executes it.

- [Session-meta package](../session-meta/README.md) — the evaluation pipeline, the harm veto, and the replay gates that consume replay outcomes.
- [Skill subsystem](../../../docs/subsystems/skills.md) — the registry and local provider vocabulary behind mounting an overlay as discoverable skill roots.
- [Session group map](../README.md) — adjacent persistence, projection, title, and telemetry packages.

-----

## Dev Note

Coverage expectation is per-file 100%: `tests/outcome.spec.ts`, `tests/patch.spec.ts`, `tests/runner.spec.ts`, and `tests/seam.spec.ts` pin the mapping, the arm routing, the patch rendering, and the single-declaration-site re-export.

## Model Experience

None, as replays run in separate SDK invocations and neither the runner nor its outcomes enter model context.

#### KV Cache effect

Replay runs never touch the agent's request context, so prefix reuse is unaffected.

## Known Limitations and Deferred Work

- **The seam is re-exported, not duplicated** — `src/types.ts` type-only re-exports `ReplayOutcome`/`ReplayRunner` from session-meta's `types.ts` through the workspace package root (project reference, no runtime import); `seam.spec.ts` pins the single declaration site.
- **The candidate overlay mounts through a generated patch file** — pass `dir => generateSkillOverlayPatch(dir, patchFile)` (see `src/patch.ts`) as the runner's `writePatch` hook and the delegate receives a `--patch` file setting the overlay as the `skill-filesystem` `customSkillDirs`; without the hook the draft directory passes through as-is, which a stock `DeepSeekHarness` ignores. A per-arm harness behind the delegate stays deferred.
- **The runner arrives by registration** — the host composition owns construction (`new SdkReplayRunner(delegate)` around an SDK run function; `generateSkillOverlayPatch` for candidate mounting) and registers it once at boot via `setReplayRunner` from `@deepseek-ai/dsh-session-meta`; `replay-composition.spec.ts` proves the replay pair flows through the registered runner end to end. Absent registration, the replay gates keep their skip-and-promote behavior. A per-arm harness behind the delegate and the SDK-delegate factory stay operator-side (they need a live runtime and profile decision, not more code).
