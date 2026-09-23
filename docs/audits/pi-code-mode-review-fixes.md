# I0–I3 review corrections

Follow-up to `ac3ad667`, on `feat/code-mode-interop-i1-i3`. Implements the
authorized order M1 → M2 → M3/L1 → L2 → L3; no registry, global installation,
release-lock or publication-eligibility changes.

## Corrections

- **M1:** existing patch targets carry bigint device/inode snapshots in addition
  to canonical paths. Same-patch hardlink aliases, including move destinations,
  fail before effects. Inode replacement during queue waits fails closed and
  releases acquired queues. Native path keys and semantic-path lock ordering
  remain unchanged. Tests check unchanged contents, absent unrelated additions,
  and queue reuse after rejection.
- **M2:** session start and tree navigation discard suppression receipts from
  the previous physical loadout. Only native tools present in the destination
  loadout can acquire new restoration receipts. Real Pi tests cover both factory
  orders, a branch without edit/write, patch deactivation and Code Mode off;
  existing tests retain restoration when the destination does declare them.
- **M3:** owned definitions record their provider ID; nested binding lookup
  requires both that ID and the existing registry identity evidence. Duplicate
  owned definitions throw before overwriting the evidence. A namesake provider
  cannot hide Codex's direct tool; granting both providers does not duplicate
  the binding or invalidate Code Mode.
- **L1:** producer requirements follow the consumer's syntax and bounded-list
  rules, with explicit/implicit features normalized before either protocol's
  filtering. A failed provider cannot return as a partial legacy mirror. The
  mixed valid/malformed declaration case was independently reproduced during
  follow-up review; regressions verify unrelated healthy providers remain usable.
- **L2:** the actual registered stream, not a synthetic offer, is tested against
  the consumer handshake and intercepted request bodies. The old native fallback
  retained obsolete section values with `supportsMidConvoSystemMessages:true`;
  it now uses Pi's `collapseSystemMessages` before native streaming. Coverage:
  both Responses APIs; enabled, globally disabled, profile-disabled and
  shim-disabled paths; JSON/grammar history; section replacement/deletion; tool
  removal/redefinition; exact controls and raw CRLF/Unicode preservation; paired
  results; immutable persisted history; handshake shutdown. Real SDK tests cover
  forced prompts and compacted checkpoints with both enabled/native paths.
- **L3:** root package rows link to authoritative manifests rather than copying
  drifting versions. Telegram metadata describes native blocking extension
  prompts. `RELEASING.md` includes a keep-defaults migration announcement,
  explicitly disclosing lost watcher protection, uninstall/restart steps, and
  the absence of npm deprecation/version-level notification.

## Verification

All final checks passed:

- `npm run ci`: complete root CI, including workspace typechecks/tests,
  architecture, release scripts, licenses, package contents and **17** isolated
  production Codex tarball/Pi combinations.
  - Code Mode **147/147**; Codex compatibility **330/330**; runtime **18/18**.
  - Subagent **159/159**; Telegram **21/21**; remaining workspace checks passed.
- `npm run ci:pi-matrix`: complete CI in separate floor and target installations,
  both resolving **Pi 0.86.1**. New tests were staged before snapshot creation.
- Real `test:host`: **55/55**, using pinned Host
  `rust-v0.155.1+pi-v8-sort.1` with user systemd/cgroups.
- Isolated `test:code-mode-package -- --host <pinned-host>` and the same command
  with trailing `--codex`: both passed, including standalone I3 pilots and the
  optional Codex patch/search/grammar/direct-owner integration.
- `npm run changeset:sync` and `git diff --check`: passed.

Retained logs: `~/.local/state/agents/tmp/interop-review-fixes.1OBof7LB/`.
The initial transport regression failed on obsolete fallback section content;
the initial test fixture also needed native zstd request decoding. Typechecking
caught an overly broad context-event array type and a missing branded transcript
in that fixture; the test now narrows its known provider-message array and uses
Pi's `normalizeContext`. The first Codex installation invocation had its flags
in the wrong order and was rejected before installation; the corrected command
passed. These are not hidden successful runs.

Final evidence:

```text
interop-review-fixes.1OBof7LB/
  ci-verified.log
  host.log
  install-standalone.log
  install-codex-verified.log
  pi-matrix.log
  omp-pi-matrix-results-McBuIy/
code-mode-s3-standalone-install-dYLpGY/
code-mode-s3-codex-install-oENyZF/
```

After matrix verification only this root audit's result wording and a historical
audit tense correction changed; production source and tests remained unchanged.

## Boundaries

Native queues are path-based cooperation, not inode locks or filesystem
isolation. Separate invocations through different hardlinks or aliases of a
missing file do not have guaranteed shared locking. Concurrent filesystem
replacement after final validation remains outside this guarantee.

Provider IDs are cooperative ABI attribution, not authentication against hostile
extensions. No generic hook-preserving native invocation, new grants, subagent
adapter or default Code Mode enablement is added. Transport integration uses
local fixtures, never real provider credentials/accounts.

The retired keep-defaults directory's historical files and ignored local
artifacts are left intact. No npm deprecation/unpublish, remote push, main merge,
global removal or user-settings edit is performed.
