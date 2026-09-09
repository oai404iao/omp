# Codex integration acceptance

Review base: `e0f8657e`, containing S1–S5 and the FIFO test correction.
Review worktree: `.worktrees/chore-codex-integration-review`.

## Findings corrected before integration

1. **Awaited completion deadline:** Node 22 cancelled `wait_agent` tests because
   the deadline timer was unreferenced and the event loop could exit. The timer
   now stays referenced for the awaited operation. Tests cover timeout, wake,
   abort, rejection and disposal; termination still clears the timer/listener.
2. **Broker cache compatibility:** the API-symbol fast path skipped the ABI,
   runtime-version and shape checks used by event-bus discovery. Both paths now
   apply the same checks. Three negative cache cases failed before the fix.
3. **Unowned native tools:** core-only or partially composed installations could
   rewrite another extension's same-named function into a native/reserved tool.
   Broker ownership now flows through ordinary requests, Lite tool construction,
   startup prewarm and compaction. Tests cover core-only/core+web/core+image,
   request-hook results, actual registered streams stopped before I/O, and Lite
   functions. Lower-level helpers without a policy preserve their legacy contract.
4. **Detached image jobs:** the background command had module-global status and
   no session shutdown cancellation. At the user's explicit choice, replacement
   and shutdown now abort jobs. Status/timers are instance-owned; late auth,
   ignored cancellation, pending SSE readers and late finish callbacks are tested.
   The old image module budget decreases from 574 to 476 lines; the new job
   module is below 400 lines. Completed provider work and started disk writes
   cannot be rolled back.

These fixes have package changesets. No workspace versions, dependency pins,
catalog/schema defaults, provenance snapshots or release qualifications changed.

## Review coverage

- Broker claims and discovery, session activation, image display generations,
  provider lifecycle/prewarm reset and late-auth handling.
- Package import graph and compatibility facades; optional capabilities remain
  runtime-only dependents and unknown model profiles remain Pi-native.
- `workspace-versioning.mjs`: recursive hard/optional consumers, exact-pin
  validation, actual Changesets normal/prerelease/exit behavior, retained history,
  idempotence and root-lock integrity preservation.
- `release-dependencies.mjs`, `release-batch.mjs`, artifact preparation and
  publisher: private/blocked closure, exact pins, dependency-first ordering,
  complete-batch qualification/hash/packed-manifest checks before publication,
  registry identity/integrity verification before consumers, and incomplete-batch
  tag suppression. Existing negative publisher tests use fake npm/git.
- Recovery history ancestry and tarball-facing diffs are verified by preparation.
  Publication additionally verifies registry identity and locked hashes. This
  assumes the protected artifact-producing job is trusted; it is not a claim
  that a compromised artifact producer can safely supply arbitrary manifests.

## Four-combination acceptance

| Node | Pi | npm | Complete CI |
| --- | --- | --- | --- |
| 22.19.0 | 0.84.2 | 11.19.0 | Passed |
| 22.19.0 | 0.85.1 | 11.19.0 | Passed |
| 24.13.0 | 0.84.2 | 11.19.0 | Passed |
| 24.13.0 | 0.85.1 | 11.19.0 | Passed |

Each combination passed 514 node:test cases, 17 independent production tarball/
Pi-loader combinations, architecture and ten-package license/pack checks.
The four source snapshots had identical SHA-256:
`e09df91397765bc456636f32e1ddb76c7e2f3c04f5a5937dcf12c878a64a84d6`.
This fingerprint precedes the final documentation-only acceptance record.

Node 22.19.0 was downloaded from nodejs.org and verified against its SHA-256
manifest. npm 11.19.0 was installed separately for these checks; the user's
default Node/npm installations were not replaced. An earlier target installation
hit `/tmp` quota; the final complete runs used a task-owned cache scratch directory.
No failing test was skipped or automatically retried.

## Integration and release boundary

The user approved preserving the original primary-checkout subagent edits and
design documents on a separate WIP branch/worktree, then local merge-commit
integration of the reviewed series. The WIP content is not part of this review
or the integration payload and must retain its original bytes.

No push, remote CI run, protected-environment change, npm publish, dist-tag
mutation or billable endpoint smoke is authorized by this acceptance record.
Release preparation remains a separate task with private/blocked dependencies
intentionally preventing artifact publication.
