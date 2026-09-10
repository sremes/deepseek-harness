---
description: "Deterministic-first approval answerer: blacklist deny plus narrow whole-command allowlist plus bounded LLM judge over the approval/request waterfall, fail-closed throughout."
kind: "package-reference"
---

# @deepseek-ai/dsh-approval-gate

## Summary

`dsh-approval-gate` is an approval answerer for unattended profiles: it listens on the `approval/request` waterfall and decides sandbox-escalation asks in three layers — an exact-deny blacklist, a narrow whole-command allowlist, and a bounded LLM judge — delegating everything else via `next()`. The service appends the asked/decided audit pair for every outcome either way, so the gate adds decisions without touching the audit contract.

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

Mount the plugin where escalation asks need answers and no human is composed (headless dogfood, CI). It needs the approval service beside it; anything else may stay unmounted.

```yaml
- name: '@deepseek-ai/dsh-user-approval'
- name: '@deepseek-ai/dsh-approval-gate'
  config:
    dshHome: !!js process.env.DSH_HOME
    apiKeyEnv: DEEPINFRA_API_KEY
```

### Config

| Field | Meaning |
|---|---|
| `dshHome` | Harness home holding the `meta` judge-budget file. Required; empty fails loud at load. |
| `judgeUrl` | Chat-completions base URL. Default `https://api.deepinfra.com/v1/openai`. |
| `judgeModel` | Judge model id on the wire. Default `deepseek-ai/DeepSeek-V4-Flash-0731`. |
| `apiKeyEnv` | Environment variable NAME holding the judge bearer key. Resolved per request, never stored; default `DEEPINFRA_API_KEY`. Absent key degrades to `next()`. |
| `timeoutMs` | Judge abort bound. Default 45000. |
| `maxCallsPerDay` | Judge calls per UTC date. Default 50; spent budgets degrade to `next()`. |

### Decision layers

1. **Blacklist** (`src/gate.ts`): exact-deny patterns (`rm -rf /`, `mkfs`, `dd … of=/dev/`, fork bombs, `curl|wget … | sh`, device redirects, `chmod -R 777 /`, power commands) → `rejected`.
2. **Allowlist**: whole-command anchored allow for the boring-read-only class (`ls`, `cat`, `echo`, `pwd`, read-only `git` porch) with every shell metacharacter banned → `allowed-once`. Anything piped, redirected, chained, or substituted falls through by construction.
3. **Judge** (`src/judge.ts`): one fixed-shape chat call over the command plus cwd, target mode, and justification — never a transcript. Schema-clean allow/reject only; every fault degrades to `next()`.

<a id="understand-the-implementation"></a>
## Understand the implementation

The ask payload carries no command — only the model's justification — so the plugin recovers it from the live `tool/call` firehose by call id (bounded 500-entry map). Failure posture: overlay faults (unrecoverable command, missing key, spent budget, judge fault, store failure) fall through to `next()`, preserving pre-mount behavior exactly; only the blacklist and an explicit judge reject claim the request. A late abort rejection after the timeout race is guarded so it can never surface as a fatal unhandled rejection.

<details>
<summary>Developer section: module map</summary>

- `src/index.ts` — function plugin (`name`/`inject`/`Config`/`apply`, no default export): firehose tap, waterfall answerer, fail-closed config resolution.
- `src/gate.ts` — pure deterministic layers (blacklist, allowlist, command recovery); unit-tested without cordis.
- `src/judge.ts` — bounded verdict call over an injectable fetch; every fault degrades to `undefined`.
- `src/budget.ts` — daily counter file under `$DSH_HOME/meta`; corrupt files reset, spent budgets refuse without writing.
- `src/types.ts` — types only.

</details>

<a id="dev-note"></a>
## Dev Note

Coverage expectation is per-file 100%: `tests/gate.spec.ts` pins the deny/allow matrix (including chained sneaks and scoped-delete fall-through), `tests/judge.spec.ts` drives every fault through an injected fetch, `tests/budget.spec.ts` covers the counter lifecycle against tmp homes, and `tests/composition.spec.ts` decides through the real approval service plus a Loader boot of the shipped shape.

<a id="further-exploration"></a>
## Further Exploration

- [Approval subsystem](../../docs/subsystems/approval.md) — request/outcome vocabulary, the answerer waterfall, and per-session policy.
- [Escalation choreography](../../sandbox/sandbox/src/escalation.ts) — the strictly-wider ladder and the ask reason this gate reads.
- [Skill filesystem roots](../../skill/skill-filesystem/README.md) — what a mounted candidate overlay looks like from the other side.

<a id="model-experience"></a>
## Model Experience

### Escalation answers

#### What the model sees

Nothing new on allow: the escalated call simply runs. On reject or delegation the tool's existing verbatim texts apply (`the user rejected…`, `no approval channel is available`) — this package contributes no prompt sections and no tools.

#### Token effect

Zero-direct token effect. Judge calls are host-side HTTP, off the agent's context and budget ledgers.

#### KV Cache effect

Independent behavior. The plugin never mutates request context, tool schemas, or system-prompt sections.

<a id="known-limitations-and-deferred-work"></a>
## Known Limitations and Deferred Work

- **The judge reads the model's own justification**, which shares the transcript with untrusted tool output. Accepted residual risk: this gate beats blanket full-access; it is not kernel confinement.
- **The judge is strict by design** — workspace-outside reads without a stated need are rejected. Loosen the system prompt only with a recorded false-positive rate, never by feel.
- **Only `bash` asks are answered** — other tools fall through to `next()`. Extend per tool with its own argument recovery, not by widening this one.
- **No per-agent scoping** — the answerer is context-global by design (a security gate must not miss agents); do not narrow it without a bypass analysis.
