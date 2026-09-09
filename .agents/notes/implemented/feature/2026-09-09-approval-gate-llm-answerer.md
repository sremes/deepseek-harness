# Agent Note: Deterministic-first LLM approval answerer

Status: implemented

No active Agent Note owns headless approval answers: the approval seam (`ask`/`never`, fail-closed) and the ACP transport answerer cover interactive and automation channels, but no decision composes an unattended judge. Nothing is superseded.

## Problem

Headless profiles compose no approval answerer, so every escalation ask falls through to `unavailable` and every confined tool call fails where no sandbox backend exists (containers without user namespaces: no bwrap, no landlock). The dogfood loop answered with blanket `danger-full-access` — full permissions for every call, no per-command decision, no audit beyond the tool result.

## Decision

`packages/interaction/approval-gate` answers `approval/request` in three layers: exact-deny blacklist → `rejected`; narrow whole-command allowlist (anchored, every shell metacharacter banned) → `allowed-once`; bounded Flash judge over command plus cwd, target mode, and justification (never a transcript) → verdict. Everything else — non-bash tools, unrecoverable commands, missing keys, spent budgets, judge faults, store failures — falls through to `next()`, preserving pre-mount behavior exactly. Spend is capped per UTC day in a counter file; the key travels by environment name, resolved per request. Fork-owned, EN-only (see the fork-divergence rule in `AGENTS.md`).

## Alternatives considered

**Prefix whitelist plus LLM for misses.** Rejected: safety is args × cwd × env × redirects, never the binary name — `echo hi; rm -rf /` passes `^echo`. The metachar ban is what makes the allowlist honest, and the deny/allow matrix spec pins it.

**LLM as sole decider.** Rejected: every call pays a model round trip, and a compromised or flaky judge becomes the single bypass. Deterministic layers decide the clear cases for free; the judge sees only the ambiguous remainder.

**LLM as advisor to a human.** Rejected for headless: no human is composed there. The advisor shape stays available — the verdict carries grounds — if an interactive profile ever wants recommendations instead of decisions.

**Extend `user-approval` in place.** Rejected: the service owns the audit contract and must stay judge-free; an answerer is a consumer of the waterfall, not a change to it.

## Consequences

Unattended runs get per-command decisions with a full asked/decided audit trail, at Flash-judge cost only for ambiguous commands. Accepted residual risk: the judge reads the model's own justification, which shares the transcript with untrusted tool output — this gate beats blanket full-access and is not kernel confinement. The judge runs strict (workspace-outside reads without stated need are rejected); loosen only with a recorded false-positive rate.

## Verification

- 31 tests green: deny/allow matrix (chained sneaks, scoped-delete fall-through), every judge fault through injected fetch, counter lifecycle, decisions through the real approval service, Loader boot of the shipped shape.
- Per-file 100% coverage on `src` (the repo CI gate); `tsc -b` clean.
- Live dogfood proof preceded the package: allowlisted, judge-rejected, and model-refused paths all observed on real runs before promotion.
