# Code Mode I0 implementation audit

I0 is complete against the stage definition in
[the interoperability plan](../plans/pi-code-mode-tool-interop.md#11-建议实施顺序).
The first implementation checkpoint is `af0eef5d`; this completion closes its
remaining safety and lifecycle gaps. I1–I3 remain separate work.

## Acceptance evidence

| Requirement | Implementation and regressions |
| --- | --- |
| Old consumers cannot bypass new approval requirements | `contributions.ts` withholds approval closures from v1; approval-dependent/resolved policies supply a v1 deny guard. `approvals.test.ts` covers feature acknowledgments, exact receipts, old hello/revision rejection and policy enforcement. |
| Missing or failed mandatory protection cannot disappear | `config.ts` accepts bounded exact `requiredPolicies`; `catalog.ts` validates the independent expectation and global policy readiness before returning a snapshot. `policy-gates.test.ts` covers missing producers, Pi-swallowed pre-offer failures, incompatible/failed/not-ready offers and missing approval providers. A real Pi test proves even local calls cannot start a Host without the required policy. |
| Initialization failure is represented, not merely thrown | Policy helpers announce not-ready before synchronous resolution, convert resolver errors to fixed failed records, and retain a legacy deny guard. `refresh()` withdraws the old revision and emits v1 invalidation before readiness. Configured expectations also cover a helper that never runs. |
| Old cells lose captured executable authority | A legacy-consumer fixture deliberately ignores approval metadata, retains a real Cell/ToolBridge snapshot and queues effects. Safe → approval-required refresh synchronously aborts it; queued and subsequent effects remain zero. Real Host refresh/cancellation regressions remain covered. |
| Owner replacement and failures remain retryable | `code-mode-owner.ts` keeps pending disposal separately from synchronous transition state. Tests cover dispose/create failure, invalid returned controls, disappearance/reappearance of the original factory, foreign/SDK/builtin/missing/unregistered replacements, shutdown cleanup, and shutdown/replacement during discovery/dispose/create callbacks. |
| Capacity counts live controls; closing forbids acquisition | Successful disposal removes controls from the factory Set. Tests exceed 64 sequential allocations, enforce 64 live controls, and verify every control is closed before any restoration callback, including after the first release fails. |
| Cleanup failure cannot skip independent cleanup | Code Mode and Codex shutdown aggregate failures while attempting remaining owners, visibility/factory cleanup and native restoration. Failed native activation writes keep restoration receipts. Tests inject failures and retry the same instance. |
| Ownership is evidence-based | Exec/wait require instance-local schema references and live source/fingerprint matches. Tests reject identical descriptions, cloned schemas and source/metadata replacements. Codex also rejects SDK/builtin replacements before activation or native suppression, both before and after acquiring a control. |
| Tree replay cannot replace current owner intent | Real Pi tests cover both extension orders, active/inactive historical candidates, current explicit inactivity, live/released leases, profile disablement, native suppression, `autoEnable:false`, explicit tool allowlists and no-system-history targets. A real Host test cancels navigation after Code Mode's before-tree hook and proves the old cell/effects stay revoked. |

The SDK/builtin replacement and injected-cleanup failures use controlled
in-memory registries. Tree, allowlist, loader, reload and Host paths use the
installed Pi SDK. These are not interchangeable claims.

## Verification actually run

- `npm run ci`: passed on the final runtime source.
  - Code Mode: **111/111**
  - Codex runtime: **18/18**
  - Codex compatibility: **319/319**
  - Other workspace checks, architecture, release scripts, licenses, pack checks.
  - **17** isolated Codex production tarball/Pi combinations.
- `npm run ci:pi-matrix`: final floor and target copies each installed
  **Pi 0.86.1** and passed complete CI.
- `npm run test:host -w @oai404iao/pi-code-mode`: **53/53** on final source,
  using the pinned `rust-v0.155.1+pi-v8-sort.1` Host, systemd and cgroups.
- `npm run test:code-mode-package -- --host <pinned-host>`: standalone production
  tarball passed, including required global policy, approval deduplication across
  local/contributed calls, legacy denial, public exports and reload.
- The same command with `--codex`: passed on final source with independent
  Code Mode/runtime/core/web tarballs, Lite grammar and real patch/search clients
  using fixture HTTP.
- Independent review found the remaining ownership/shutdown gaps before this
  completion. A subsequent review ran 45 focused tests without a must-fix finding.
  Final transition inspection additionally added six reentrant
  shutdown/replacement tests, followed by final CI/matrix/Host/Codex probe runs.

The initial root CI failed five activation tests because an older mock omitted
`getAllTools()`. Another composition mock exposed raw definitions without
`sourceInfo`. Both now model Pi's public metadata and preserve schema references;
assertions were not weakened and production ownership checks were not bypassed.

Machine-local retained logs:

```text
~/.local/state/agents/tmp/code-mode-i0-complete.IBVergJB/
  ci.log                         initial failure
  ci-final.log                   final root CI
  host-final.log                 final 53-test Host suite
  install-standalone.log
  install-codex-final.log
  pi-matrix-final.log
  omp-pi-matrix-results-Y2jaL7/
```

Isolated installation evidence:

```text
~/.local/state/agents/tmp/code-mode-s3-standalone-install-6ixNxr/
~/.local/state/agents/tmp/code-mode-s3-codex-install-l0R4Nw/
```

## Boundaries

- No real accounts, billable endpoints, interactive UI, registry publication or
  main-branch integration were exercised. Global Pi and old trial configs were
  not modified. Provider network traffic is fixture-only.
- `requiredPolicies` restricts nested admission; it does not grant tools or
  retrofit protection onto direct tools. A legacy consumer cannot infer an
  absent mandatory producer. Such configurations require this consumer and are
  not advertised as transparently downgradeable.
- Receipt identities remain per-discovery, in-process cooperative evidence.
  General v2 features, durable/session generations, revision rollback detection,
  full structural v2 clients and cross-install conformance belong to I1.
- Classified refresh, prompt sections and transcript transport declarations
  belong to I2; actual new adapters belong to I3. The complete 16-part future
  verification matrix is not declared complete by this I0 audit.
- No cross-instance logical-intent persistence or authority inheritance was
  added. New/resume/fork/reload use fresh registrations, configuration and grants.
- Cleanup failures are reported and receipts retained for same-instance retry;
  they are not a guarantee that Pi will retry a failed shutdown after destroying
  the extension runtime. Foreign tools are never “restored” using old receipts.
