# Pi 0.86.1 native API migration

Implemented after I0 (`c976ab9e`). I0's policy, approval, ownership, lease,
retryable cleanup and tree-intent guarantees remain in place. This is not
completion of the remaining I1–I3 interoperability work.

## Changes

- **File mutations:** Codex directly imports Pi's `withFileMutationQueue`;
  there is no silent unqueued fallback. Multi-file acquisition is ordered by
  semantic target identity, including missing targets. Different lexical paths
  aliasing one target are rejected before mutation, while repeated actions on
  the same path remain valid. Snapshots are rechecked after queue waits and
  before mutation; drift fails closed and unwinds acquired queues.
- **Code Mode:** stable instructions use `sections.code_mode`, not a forced
  whole prompt or transient cell list. Unavailability removes the contribution
  on the next prompt. Other sections and explicitly forced prompts retain their
  native semantics. Historical sections never restore executable authority.
- **Subagent:** one-shot `report` denial uses native `excludeTools`, including
  late inherited registrations when no allowlist was supplied. Continuable
  reporting, mandatory-tool validation and `$mutation` selection remain.
- **Telegram:** native `ui_prompt_start` replaces tool-name timers and rpiv
  questionnaire matching. All blocking extension dialogs can notify; summaries
  use titles or a generic fallback, not full questions. Pi coalesces overlapping
  dialogs. End events do not send another Telegram message. Child suppression
  and `agent_settled` completion notifications remain.
- **keep-defaults:** implementation, tests, workspace/lock links and active
  packaging/release entries are removed. Migration README, changelog, license
  and immutable release locks remain. Existing installations require removal
  and a full Pi restart; no user settings or registry state were changed.

## Review findings addressed

Initial canonical lock deduplication was insufficient: the patch planner keeps
lexical virtual-file identities and could lose edits through aliases. A missing
file becoming present during a wait could also make native lock keys converge.
The implementation now rejects conflicting aliases, orders by semantic identity
instead of transient queue keys, and checks identity drift after waits.

A follow-up review found no further production must-fix within the documented
boundaries. Its timing-dependent test observation was addressed with an explicit
abort-checkpoint barrier instead of a 50 ms scheduling assumption.

## Verification actually run

- Final root `npm run ci`: passed.
  - Code Mode: **116/116**.
  - Codex compatibility: **326/326**.
  - Subagent: **159/159**.
  - Telegram: **21/21**.
  - Remaining workspace checks, architecture, release scripts, licenses and
    package checks passed.
  - **17** isolated Codex production tarball/Pi combinations passed.
- `npm run ci:pi-matrix`: complete CI passed in separate floor and target
  installations, both resolving **Pi 0.86.1**.
- Real Pi prompt tests cover both extension orders, exact forced prompts,
  section deletion, manual and automatic compaction, grammar/JSON changes,
  unavailable grammar, and a fresh restored session without grants.
- Real Pi runner tests cover overlapping dialogs, closing an outstanding dialog
  after shutdown, and a subsequent waiting span. UI callbacks and Telegram
  responses are fixtures, not live terminal/Telegram acceptance.
- Independent queue probes reproduced the original alias issues; new tests
  cover alias rejection, missing-file convergence, lock reuse after drift,
  repeated-path chains, overlapping patches and native mutation coordination.

Early prompt fixtures needed correction for Pi's explicit
`constrainedSampling: false` and compaction thresholds. A later CI run caught an
incomplete UI fixture type; it now extends Pi's own no-op UI context. Final CI
and matrix were run after these corrections, without weakening assertions.

Retained logs:

```text
~/.local/state/agents/tmp/pi-0861-native-apis.sHL7hH0R/
  ci.log                    first implementation checkpoint
  ci-final.log              incomplete UI fixture type failure
  ci-verified.log           final source: complete CI passed
  pi-matrix.log
  omp-pi-matrix-results-KQBOla/
```

## Boundaries

Pi's queue is cooperative, not filesystem isolation. It uses lexical keys for
missing files; separate calls through different aliases of a nonexistent file
are not guaranteed to share one queue. Use consistent paths. Arbitrary concurrent
directory/symlink replacement is not made atomic by snapshot checks.

No real Host suite, real provider/account calls, live Telegram delivery,
interactive terminal acceptance, npm publication/deprecation, global
uninstallation or main-branch integration was performed in this migration.
The prior I0 Host verification is historical evidence, not a test rerun here.
