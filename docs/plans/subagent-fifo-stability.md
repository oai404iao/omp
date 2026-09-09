# Subagent FIFO stability

## Scope

- Branch: `fix/subagent-fifo-stability`, based on `66ed24cf`.
- Worktree: `.worktrees/fix-subagent-fifo-stability`.
- Preserve the primary checkout's unrelated subagent edits and the S1–S5 branch.
- No runtime, schema, package version, dependency lock, release eligibility,
  merge, push or publication changes.

## Root cause

The original test invoked two sends through `Promise.all` and assumed that the
first array element would report `pendingMessages: 1`. `Promise.all` preserves
input positions, not completion or append order.

`sendMessageAdmitted` first awaits `resolveTarget`, which performs asynchronous
catalog discovery. Only then does it enter `AgentOperationQueue` using the
resolved durable agent id. Concurrent target lookups may finish in either order.
`enqueueMailboxMessage` reports the pending count at its serialized append;
claims and replay retain that durable order.

The unmodified test failed once in 15 isolated runs. Holding real target lookup
results and releasing the second one first reproduced the original `2 !== 1`
assertion deterministically. This is a test expectation error, not evidence of
lost messages or reordered durable FIFO records.

## Fix and regression coverage

- Control both lookup completion orders with promise gates, not timing sleeps
  or retries. Both requests remain in flight and use the real operation queue.
- Cover cold children and retained idle runtimes, addressing the same child
  through its durable id and readable path.
- Check that serialized sends never overlap, each append returns the expected
  count and unique UUID, and both addressing forms return the same identity.
- Compare persisted message ids and contents against the forced append order,
  then restart the coordinator and consume exactly one two-message FIFO turn.
  Both messages must be present in model context in that order.
- Retain no-auto-run/no-notification, pending/unread counts and empty-batch
  rejection assertions.
- Test fixture cleanup after lookup rejection and synchronous request failure.
- Clarify FIFO semantics in the published README; the changeset is for that
  documentation change, not a runtime fix.

Temporarily bypassing the production serialization queue made all four
regression cases fail their overlap assertion. That mutation was restored;
production source files are unchanged. Checking only final append counts was
not sufficient to detect this mutation, hence the explicit overlap guard.

## Verification

- Node 24.13.0: subagent typecheck and all 151 package tests passed.
- Thirty fresh-process stress runs passed all six selected cases each: four
  FIFO permutations and two fixture-failure cleanup cases (180 executions,
  zero failures). This is a deliberate stress check, not an automatic CI retry.
- Full Pi 0.84.2 / 0.85.1 matrix passed: 495 node:test cases and 17 production
  tarball/loader combinations per baseline, plus 191-module architecture and
  ten-package license/pack checks.
- Changeset synchronization/status and diff checks passed. Runtime source,
  schemas and the root lock are unchanged; no versioning was executed.

An earlier combined stress/matrix shell invocation exceeded its harness timeout
during target installation checks, leaving owned temporary fixtures. The next
target attempt hit temporary filesystem quota. After removing those abandoned
fixtures, the complete matrix passed on both baselines. These incomplete runs
are not counted as successful validation or as FIFO regressions.

Earlier S1–S5 flaky observations remain historical evidence. Remote CI, local
Node 22.19.0, real endpoints and account/publication checks were not run here.
