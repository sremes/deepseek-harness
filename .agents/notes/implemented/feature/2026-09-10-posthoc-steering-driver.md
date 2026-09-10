# Agent Note: Post-hoc steering driver (background loop closure)

Status: implemented

No active note owns post-exit steering: steering.ts documents the offline
loop reading `meta/steering/*.json`, but only the live flush path ever read
them — headless one-shot records sat unread forever, and the route gate
(`track_a` only) would have skipped most of them anyway.

## Decision

Drive pending records through the exact live pipeline instead of a parallel
one: `drivePendingSteering` (new `src/driver.ts`, exported from the package
root) reuses `shouldEvaluateTrackA` and `evaluateTrackASession` unchanged.
Background evaluations differ from live ones only in trigger, never in
standards. The explicit file bypasses the route gate (the record IS the
steering signal triage never saw) but keeps the effort gate — a correction
on a session where nothing happened teaches nothing.

## Supporting changes

- Schema v8 `meta_aggregates` table: finalized aggregates persist at flush
  (inside the existing lifecycle-signal guard, so a cache failure can never
  break the pipeline). `pendingToolCalls` serializes as entries; corrupt
  rows read as `undefined` (skip-with-log, never throw).
- `shouldEvaluateTrackA` moved from `index.ts` to its owning module
  `orchestrate.ts` (one owner for the gate both paths share); index
  re-imports it, one test import updated.
- `MetaStore.hasEvaluation` gives the driver a cross-process evaluated set
  (the live path's in-memory set does not survive exit).
- Consumption is idempotent because the evaluator itself moves the file on
  success — a missing source means the goal state already holds.

## Deliberate non-goals

- ~~No trigger in this slice~~ Trigger landed the same night: `driveOnBoot`
  plugin flag (default false) queues one drive on first finalize into the
  shared settle drain; `dsh-meta-smoke/driver.patch.yml` + a nightly Hermes
  cron run (`dsh-nightly-steering-drive`, 03:00) boots headless against the
  dogfood store with it. Nothing else calls the driver.
- No aggregate backfill for pre-v8 sessions: records without a cached
  aggregate stay pending with a `no-aggregate` skip rather than
  synthesizing state.
- No replay runner in the background drive: L2/L3 skip exactly as they do
  in headless today; promotion rules unchanged.
