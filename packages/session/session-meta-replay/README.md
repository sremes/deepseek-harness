---
description: "SDK-backed replay driver for the dsh-meta learning loop: RunResult-to-outcome mapping plus the candidate/baseline replay runner for operators composing or debugging the M3 L2/L3 gates."
kind: "package-reference"
---

# @deepseek-ai/dsh-session-meta-replay

## Summary

`dsh-session-meta-replay` is the SDK-backed replay driver for the dsh-meta learning loop (Plan-V1 M3 §4.1 L2/L3 + Q15). It turns one owned SDK activity interval into the `ReplayOutcome` data the harm veto and the pairwise judge read, and it drives the two replay arms — candidate (with the skill overlay) and baseline (without it) — over an injected narrow run function. The evaluation pipeline in `@deepseek-ai/dsh-session-meta` receives the runner through `EvaluationDeps.replayRunner`; this package never imports `sdk-client`, `dsh-session`, or `dsh-llm` at runtime, so the session-meta dependency constraint holds by construction.

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

`mapRunResultToOutcome(events, finalResponse)` folds one interval: `completed` is true only when the last `turn/end` reason has the `completed` kind (the single M2.2 completion definition, shared with `isCompletedTurnEnd` in session-meta's `projection.ts`); `turnEnd` is that reason's kind verbatim, or null when no turn ended. `steeringCount` counts human (`user`-kind) `user/message` events after the first `assistant/message` — the same rule `triage.ts` uses, so the opening prompt never counts and relays, tool frames, and plugin notices never count. `toolCalls` counts `tool/call` events. `summary` is the final response truncated to `REPLAY_SUMMARY_MAX_CHARS` (2000 chars).

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains why the adapter lives here and how the two modules split; the observable behavior is fully covered in [Use this package](#use-this-package).

### Design concept

The adapter is a sibling package — not part of `dsh-session-meta` — because session-meta may only depend on `@deepseek-ai/schemastery` at runtime and must never import `sdk-client`, `dsh-session`, or `dsh-llm` there. The runner needs `SessionEvent` (a type-only import, erased at build) and a run function shaped like `DeepSeekHarness.run`; keeping both behind this package's boundary leaves session-meta's runtime closure untouched while the pipeline keeps receiving the runner through the existing optional `EvaluationDeps.replayRunner` field.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Package entry: re-exports the seam, mapping, and runner |
| [`src/types.ts`](src/types.ts) | Type-only seam: outcome, run options/result, narrow run function, runner options |
| [`src/outcome.ts`](src/outcome.ts) | Pure interval-to-outcome fold plus the summary bound |
| [`src/runner.ts`](src/runner.ts) | `SdkReplayRunner`: arm routing over the injected delegate plus mapping |
| — | No runtime invariant companion is published: the package owns a pure fold and a thin routing class with no independent observable state to compare against; completion ordering is owned by the session loop and the SDK runtime. |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package contract is not enough. They move from the replay seam to the pipeline that consumes it and the runtime that executes it.

- [Session-meta package](../session-meta/README.md) — the evaluation pipeline, the harm veto, and the L2/L3 gates that consume replay outcomes.
- [Skill subsystem](../../docs/subsystems/skills.md) — the registry and local provider vocabulary behind mounting an overlay as discoverable skill roots.
- [Session group map](../README.md) — adjacent persistence, projection, title, and telemetry packages.

-----

<a id="model-experience"></a>
## Model Experience

### Replayed task input

#### What the model sees

The caller-supplied task input, sent verbatim as the replay prompt on a fresh (or named) SDK session — once per arm, so one candidate run with the overlay and one baseline run without it.

#### Token effect

Conditional input cost: each replayed arm pays the task prompt plus whatever the run itself generates; this package adds no system text, catalog, or tool schema of its own.

#### KV Cache effect

Independent: every replay runs on its own session with no shared prefix, so nothing here preserves or invalidates provider cache reuse — the delegate runtime owns request assembly.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define what the driver does not do yet. They are current package constraints, not a task backlog.

- **The seam is re-exported, not duplicated** — `src/types.ts` type-only re-exports `ReplayOutcome`/`ReplayRunner` from session-meta's `types.ts` through the workspace package root (project reference, no runtime import); `seam.spec.ts` pins the single declaration site.
- **The candidate overlay mounts through a generated patch file** — pass `dir => generateSkillOverlayPatch(dir, patchFile)` (see `src/patch.ts`) as the runner's `writePatch` hook and the delegate receives a `--patch` file setting the overlay as the `skill-filesystem` `customSkillDirs`; without the hook the draft directory passes through as-is, which a stock `DeepSeekHarness` ignores. A per-arm harness behind the delegate stays deferred.
- **Nothing constructs or hands over the runner yet** — `EvaluationDeps.replayRunner` stays undefined in production, so L2/L3 keep their skip-and-promote behavior until the wiring slice owns construction (bundle composition or a context service), lifetime, and budget interplay.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

Placement decision (M3 SDK replay adapter slice): the adapter lives in this new sibling package because the hard constraint — session-meta has only `@deepseek-ai/schemastery` at runtime — forbids putting the runner there, and the canonical seam types are not exported from session-meta's root. Steps 1 (outcome mapping) and 2 (runner over an injected delegate) land here; step 3 (real profile-patch mounting plus construction/wiring into `EvaluationDeps`) is deferred as designed in the slice handoff.

</details>
