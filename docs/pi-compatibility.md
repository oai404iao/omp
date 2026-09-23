# Pi compatibility baselines

## Tested scope

| Role | Version | Policy |
| --- | --- | --- |
| Supported-package floor | 0.86.1 | Every public Pi peer is `>=0.86.1` |
| Development / target | 0.86.1 | Exact root and supported-workspace dev dependencies |
| Private tree-continue hook | 0.86.1 only | Blocked/private compatibility experiment; excluded from public support |

Pi 0.85.x is no longer supported. Pi 0.86 changes provider callbacks to
normalized `TranscriptContext` and constrains tool arguments/results to JSON.
The minimum and target advance together to 0.86.1; there is no older-SDK
compatibility layer. See the
[0.86.0 release](https://github.com/earendil-works/pi/releases/tag/v0.86.0) and
[0.86.1 release](https://github.com/earendil-works/pi/releases/tag/v0.86.1).

The floor and target roles currently converge on the exact 0.86.1 install. The
floor role still regenerates the projected lock while the target role tests the
committed lock; keeping both roles allows a future target to advance without
silently changing the published minimum.

Codex catalog entries, default tools, schemas, wire formats, provenance and
package release eligibility are unchanged. New upstream models do not
implicitly become configured Codex profiles. The provider boundary replays
Pi's system sections and tool deltas into the complete prompt/loadout required
by the existing Standard/Lite encoders; native fallback receives the original
transcript. This does not implement in-place delta transport or promise cached
prefix retention when prompts/tools change.

Native compaction keeps the effective system checkpoint, including request-local
updates. Child sessions inherit completed conversation data and summaries, not
the parent's authoritative system prompt or tool declarations. External Thinking
recognizes OpenAI in-conversation tool additions as well as top-level tools.
The private `/continue` hook prepares transcript state and delegates run/retry/
abort cleanup to Pi's audited run lifecycle without adding a user message. It
retains recorded prompt sections rather than rebuilding an interrupted turn
from base options, and restores normal preparation before settlement callbacks.
Code Mode's owner-side leases retain their released restoration intent across
Pi's historical tool-loadout restoration, without activating replaced or
explicitly inactive definitions.

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

Pi's published shrinkwrap omits integrity for five nested 0.86.1 packages
(chord, agent-core, ai, telemetry and tui). The root lock includes their
registry SHA-512 values, verified against downloaded tarball bytes.
`preserveRegistryIntegrity` retains these exact artifact hashes during floor
projection; the production-consumer check still rejects unhashed dependencies.

Failed copies are removed but their logs are retained. The matrix returns failure
if either baseline fails; it does not automatically retry failing tests.
`OMP_PI_MATRIX_LOG_DIR` optionally selects a parent directory for unique log sets.
The read-only GitHub workflow covers both Pi roles on Node 22.19.0 and 24.x and
uploads diagnostics. Configuring that matrix is not a claim that remote jobs
have already passed.

## Checks that prevent false positives

- Root SDK anchors keep every workspace, including the private tree-continue
  hook, on the single audited 0.86.1 SDK.
- `check:pi-baseline` checks both declared and actually resolved SDK versions for
  every workspace.
- Loader probes use each installed consumer's SDK and check its package version
  and exported VERSION. Ordinary, reversed and duplicate package loading all run.
- The private hook is loaded by the active real Pi 0.86.1 loader. It registers
  `/continue` and patches the intended `AgentSession` prototype, but it is not
  part of the public support claim.
- A credential-free offline CLI probe explicitly loads the compatibility bundle.
- Consumer probes run in separate processes to avoid cross-case module globals
  and release temporary installations promptly to bound disk/memory use.
- Provider fixtures normalize contexts before dispatch, like the real SDK.
  Real SDK tests exercise Standard/Lite prompts and dynamic tool changes;
  additional regressions cover compaction checkpoints, inherited system
  authority, continuation after cancellation and JSON argument shapes.

## Limits and known issues

The configured matrix covers Node 22.19.0 and 24.x against both lock-validation
roles at Pi 0.86.1. It does not claim validation of every future Node or Pi
release or execution of remote GitHub jobs. Older audit records describe the
former 0.84.2/0.85.1 floors and remain historical evidence, not current compatibility.
There are no real account, billable endpoint, interactive UI or publication tests.
Core protocol snapshots remain the repository's reviewed compatibility contract,
not a blanket adoption of upstream protocol/model changes.

The subagent FIFO test intermittently asserted `2 !== 1` during S5. The
[stability follow-up](plans/subagent-fifo-stability.md) identified and corrected
its invocation-order assumption using controlled lookup completion orders.
The runtime queue was not changed; no retry or test-skipping workaround was added.
