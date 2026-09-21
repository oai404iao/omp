# Code Mode I1–I3 implementation audit

Implemented on top of I0 (`c976ab9e`) and native API migration (`b4ca1ad0`).
I3 follows the user's explicit selection: standalone inventory query, opt-in
native-local Pi ls, and **no subagent adapter**. Final matrix validation passed.

## Implementation and evidence

- Public v2 declarations support required features, provider/tool availability
  and tool-level required policies. Approval/observer records are separate from
  data tools. Mandatory global protection still fails closed.
- Instance-local discovery state tracks stable consumer identity/generation,
  bounded registration revision high-water marks, same-revision executable
  identity, withdrawals and prior-v2 provenance. Unavailable revisions cannot
  roll back; withdrawn owners cannot return through unidentified v1 mirrors.
  Helper and Codex structural-client fixtures cover generations, exact receipts,
  old consumers and legacy mirror suppression.
- Structural unsettled-effect errors stop queued effects across module copies;
  diagnostic length cannot disable recognition. Result adapters explicitly map
  JSON/text data rather than exposing arbitrary native details or controls.
- Classified refresh compares executable authority, not just notification
  labels. Diagnostic collection cannot replace the revocation baseline.
  Semantic duplicates include cloned v2/v1 notifications. Revocation is
  synchronous; teardown/recollection is coalesced, and failure remains observable.
- Codex's optional client resolves executor snapshots once per revision. Its
  transport declares exact-stream effective-checkpoint projection with required
  transcript semantics; conflicting/incomplete v2 declarations cannot fall back
  through a legacy mirror. Existing JSON/grammar/history, compaction and
  ownership tests remain in the suite.
- Inventory is independently loadable and shares its business query/validation
  between direct and nested entry points. Pi builtin ls is separately installed,
  separately granted, explicitly local/current-user authority, and never resolves
  or hides an existing registry override. Native text, entry limits and truncation
  counters are mapped explicitly. No extra builtin or subagent capabilities load.

## Verification actually run

- Final root `npm run ci`: passed.
  - Code Mode **134/134**, Codex compatibility **326/326**, runtime **18/18**.
  - Other workspace tests, architecture, release scripts, licenses and pack checks.
  - **17** isolated Codex production tarball/Pi combinations.
- Pinned real Host/systemd/cgroup suite: **55/55** passed.
  - New live-cell test proves observer/presentation changes preserve the same
    Host and store, while executable refresh revokes old IDs and clears store.
  - Both approved I3 pilots execute through real Host grants.
- Standalone production Code Mode tarball: passed with v2-required feature,
  public structural error export, both I3 pilots, required policy/approval,
  legacy deny gate, grammar, shared-Host cells and reload.
- Independent Code Mode + runtime/core/web production tarballs: passed with
  Lite grammar, real patch/search clients over fixture HTTP and owner visibility.
- Final Pi floor/target matrix: complete CI passed in both isolated roles,
  each actually resolving **Pi 0.86.1**.

Standalone fixtures use isolated installations and the installed Pi loader.
The inventory unit fixture loads without a Code Mode grant; the packaged
standalone probe actually loads its shipped file. Native ls unit tests check
entry limits, hidden files, cancellation and intentionally disclosed paths
outside the Code Mode root. No current registry tool is called by name.

## Review and failed-check history

Independent reviews found and prompted regressions for:

1. Diagnostic collection replacing the baseline needed to revoke old cells.
2. Unavailable revisions not establishing rollback protection.
3. Failed approval offers being admitted.
4. Long unsettled messages accidentally becoming ordinary failures.
5. Object-only notification deduplication.
6. Stale consumer generations escaping through legacy discovery.
7. Unavailable declarations escaping count/schema budgets.
8. Withdrawal tombstones losing to later legacy-only offers.
9. Structural callbacks recreating inline executors within one revision.
10. Duplicate implicit/explicit approval requirements.

All are addressed by implementation and regressions. Early checks also exposed
changed diagnostic wording and fixture type/module-identity assumptions, which
were corrected without removing safety assertions.

The first full Host run passed 54/55: model-select coalescing swallowed an
invalidation failure formerly reported through Pi's extension error handler.
Keeping the rejection observable fixed that regression; the final full suite
passed 55/55.

Retained logs:

```text
~/.local/state/agents/tmp/code-mode-i1-i3.J5dOXXkS/
  ci.log                 fixture type failure
  ci-final.log           root CI before the final error-propagation correction
  ci-verified.log        final root CI
  host-final.log         initial 54/55 Host run
  host-verified.log      final 55/55 Host run
  install-standalone.log
  install-codex.log
  pi-matrix.log
  omp-pi-matrix-results-qQveIF/
```

## Boundaries

This is a cooperative in-process ABI, not authentication or isolation against
malicious extensions. Receipts, owner identities and grants are not reconstructed
from transcript declarations. New/resume/fork/reload use fresh instances.

The standalone inventory deliberately supports v2 only; its direct tool remains
available to older consumers. Codex and public registration helpers retain audited
legacy-safe mirrors. An unidentified legacy owner cannot take over a namespace
previously seen through v2 within the same consumer instance.

No account/provider access, live interactive approvals, registry publication,
global configuration changes or main integration were performed. Fixtures are
not universal endpoint acceptance or proof of every future third-party adapter.
Subagent control/query, media adapters, generic hook-preserving invocation,
cross-session authority persistence and new package publication remain outside
this approved scope.
