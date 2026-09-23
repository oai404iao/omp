# Pi compatibility baselines

## Tested scope

| Role | Version | Policy |
| --- | --- | --- |
| Supported-package floor | 0.87.0 | Every public Pi peer is `>=0.87.0` |
| Development / target | 0.87.1 | Exact root and supported-workspace dev dependencies |
| Private tree-continue hook | 0.87.0, 0.87.1 only | Blocked/private compatibility experiment; excluded from public support |

Pi 0.86.x and earlier are no longer supported. Pi 0.87 makes SessionManager
canonical and adds append-only context edits. There is no older-SDK fallback.
See the [upstream changelog](https://github.com/earendil-works/pi/blob/v0.87.1/packages/coding-agent/CHANGELOG.md).
The floor role regenerates its projected lock; the target uses the committed lock.

Only the verified `openai-codex/gpt-6-sol` and `openai-codex/gpt-6-luna`
profiles are added. Pi 0.87.1 supplies their descriptors; the 0.87.0 floor does
not gain model registration from this extension. No family-wide match, fast
billing multiplier or public-API cache TTL is inferred. Package release
eligibility is unchanged. The provider boundary replays
Pi's system sections and tool deltas into the complete prompt/loadout required
by the existing Standard/Lite encoders; native fallback receives the original
transcript. This does not implement in-place delta transport or promise cached
prefix retention when prompts/tools change.

Native compaction v4 stores a retain-none checkpoint: its opaque payload already
covers the preceding context. The ordinary `context` hook replaces only the
checkpoint marker still present in its input; it neither restores system state
nor rebuilds a tail from raw history. Pi restores current prompt/tool state.
Legacy checkpoints replay only untransformed canonical input; a preceding
context transform instead aborts with a request to run `/compact` on the
original model. This migrates the checkpoint without guessing a boundary or
discarding opaque history. Failed recompression preserves the checkpoint.
Opaque checkpoints remain tied to their provider/model/API/profile.

Child sessions apply the complete canonical projection before selecting completed
turns. Omissions and content replacements are not undone; parent system authority
is excluded. Child completion is collected from finalized events, not offsets
in a mutable context array. Grammar eligibility likewise uses effective context.
External Thinking
recognizes OpenAI in-conversation tool additions as well as top-level tools.
The private `/continue` hook prepares transcript state and delegates run/retry/
abort cleanup to Pi's audited run lifecycle without adding a user message. It
retains recorded prompt sections rather than rebuilding an interrupted turn
from base options, and restores normal preparation before settlement callbacks
and deferred runs. Navigation previews must preserve the effective prefix,
including edits; `--force` cannot restore omitted or replaced content.
Notifications and cleanup remain on `agent_settled`. Real SDK regressions
exercise bounded `agent_before_settle` continuation without adding automatic
parent wakeups or an idle-command replacement.
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

Pi's published shrinkwrap can omit integrity for nested packages
(chord, agent-core, ai, telemetry and tui). The root lock includes their
registry SHA-512 values, verified against downloaded tarball bytes.
`preserveRegistryIntegrity` retains these exact artifact hashes during floor
projection. The two floor-only artifacts (chord and pi-telemetry 0.87.0) have
byte-verified registry hashes in `scripts/pi-baselines.mjs`; they cannot borrow
0.87.1 integrity or match another URL/version. Unknown or conflicting hashes
still fail closed; the production-consumer check rejects unhashed dependencies.

Failed copies are removed but their logs are retained. The matrix returns failure
if either baseline fails; it does not automatically retry failing tests.
`OMP_PI_MATRIX_LOG_DIR` optionally selects a parent directory for unique log sets.
The read-only GitHub workflow covers both Pi roles on Node 22.19.0 and 24.x and
uploads diagnostics. Configuring that matrix is not a claim that remote jobs
have already passed.

## Checks that prevent false positives

- Root SDK anchors keep every workspace, including the private tree-continue
  hook, on the selected baseline's exact SDK.
- `check:pi-baseline` checks both declared and actually resolved SDK versions for
  every workspace.
- Loader probes use each installed consumer's SDK and check its package version
  and exported VERSION. Ordinary, reversed and duplicate package loading all run.
- The private hook is loaded by each baseline's real Pi loader. It registers
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
roles at Pi 0.87.0 and 0.87.1. It does not claim validation of every future Node or Pi
release or execution of remote GitHub jobs. Older audit records describe the
former 0.84.2/0.85.1 floors and remain historical evidence, not current compatibility.
There are no real account, billable endpoint, interactive UI or publication tests.
Core protocol snapshots remain the repository's reviewed compatibility contract,
not a blanket adoption of upstream protocol/model changes.

The subagent FIFO test intermittently asserted `2 !== 1` during S5. The
[stability follow-up](plans/subagent-fifo-stability.md) identified and corrected
its invocation-order assumption using controlled lookup completion orders.
The runtime queue was not changed; no retry or test-skipping workaround was added.
