# Pi compatibility baselines

## Tested scope

| Role | Version | Policy |
| --- | --- | --- |
| Supported-package floor | 0.85.1 | Every public Pi peer is `>=0.85.1` |
| Development / target | 0.85.1 | Exact root and supported-workspace dev dependencies |
| Private tree-continue hook | 0.84.2 only | Blocked/private compatibility experiment; excluded from public support |

Pi 0.85.0 is explicitly excluded. Upstream reports that 0.85.1 fixes SDK
imports broken by accidentally published experimental code/dependencies in
0.85.0. See the
[0.85.1 release](https://github.com/earendil-works/pi/releases/tag/v0.85.1) and
[0.85.0 release](https://github.com/earendil-works/pi/releases/tag/v0.85.0).
The open peer range therefore starts at `>=0.85.1`, not `>=0.85.0`.

The floor and target roles currently converge on the exact 0.85.1 install. The
floor role still regenerates the projected lock while the target role tests the
committed lock; keeping both roles allows a future target to advance without
silently changing the published minimum.

Codex catalog entries, default tools, schemas, wire serialization, replay,
provenance and package release eligibility are unchanged. New upstream models
do not implicitly become configured Codex profiles.

## Commands

```bash
npm ci --ignore-scripts
npm run ci                  # Complete checks for the installed target
npm run ci:pi-matrix         # Complete floor + target verification in temporary copies
npm run ci:pi-floor          # Floor only
npm run ci:pi-target         # Target only
```

The matrix copies **tracked working-tree files**, including staged new files.
Stage new source files before invoking it; it does not copy arbitrary untracked
configuration, stage changes, or commit the caller's work. Each copy gets an
independent node_modules tree; there are no links back to the workspace.
Logs include the Node version, exact Pi version and source SHA-256. Sources must
remain unchanged between the two snapshots.

The target copy uses the root lock unchanged. The floor copy projects the exact
floor development pins, creates a temporary lock from the root-lock seed, and
runs its own clean installation and complete CI. This preparation can read npm
registry metadata; it is not an offline lock-generation promise. The resulting
Codex production consumers use locked offline npm ci. Temporary fixture locks
are removed, not committed as a second project lock.

Failed copies are removed but their logs are retained. The matrix returns failure
if either baseline fails; it does not automatically retry failing tests.
`OMP_PI_MATRIX_LOG_DIR` optionally selects a parent directory for unique log sets.
The read-only GitHub workflow covers both Pi roles on Node 22.19.0 and 24.x and
uploads diagnostics. Configuring that matrix is not a claim that remote jobs
have already passed.

## Checks that prevent false positives

- Root SDK anchors prevent npm from hoisting the private tree-continue hook's
  0.84.2 SDK as the harness for public packages pinned to 0.85.1.
- `check:pi-baseline` checks both declared and actually resolved SDK versions for
  every workspace.
- Loader probes use each installed consumer's SDK and check its package version
  and exported VERSION. Ordinary, reversed and duplicate package loading all run.
- The private hook is loaded by the active real Pi 0.85.1 loader. It registers
  nothing, warns, and leaves the target prototype unchanged despite retaining
  its own exact 0.84.2 peer/dev SDK. It is not part of the public support claim.
- A credential-free offline CLI probe explicitly loads the compatibility bundle.
- Consumer probes run in separate processes to avoid cross-case module globals
  and release temporary installations promptly to bound disk/memory use.

## Limits and known issues

The configured matrix covers Node 22.19.0 and 24.x against both lock-validation
roles at Pi 0.85.1. It does not claim validation of every future Node or Pi
release or execution of remote GitHub jobs. Older audit records describe the
former 0.84.2 floor and remain historical evidence, not current compatibility.
There are no real account, billable endpoint, interactive UI or publication tests.
Core protocol snapshots remain the repository's reviewed compatibility contract,
not a blanket adoption of upstream protocol/model changes.

The subagent FIFO test intermittently asserted `2 !== 1` during S5. The
[stability follow-up](plans/subagent-fifo-stability.md) identified and corrected
its invocation-order assumption using controlled lookup completion orders.
The runtime queue was not changed; no retry or test-skipping workaround was added.
