# Pi compatibility baselines

## Tested scope

| Role | Version | Policy |
| --- | --- | --- |
| Supported-package floor | 0.99.1 | Every public Pi peer is `>=0.99.1` |
| Development / target | 0.99.1 | Exact root and workspace dev dependencies |
| Private tree-continue hook | 0.87.0, 0.87.1 only | Disabled on 0.99.1; blocked/private and excluded from public support |

Pi versions before 0.99.1 are no longer supported by public packages. There is
no older-SDK fallback. SessionManager remains canonical, including append-only
context edits.
See the [upstream changelog](https://github.com/earendil-works/pi/blob/v0.99.1/packages/coding-agent/CHANGELOG.md).
The floor role regenerates its projected lock; the target uses the committed lock.
Both roles now use the same version but retain these distinct lock checks.

## Native codemode integration

- Active standalone `web_search` and `image_generation` use `direct` exposure
  and can be called from codemode. Hosted profiles use `model-only`, retaining
  their provider declarations in both codemode `on` and `only` modes. Explicit
  direct fallback does not change a hosted profile's exposure.
- Exposure follows model selection without replacing foreign tools or
  overriding `autoEnable: false`. Hosted placeholder results are errors.
- `apply_patch` stays callable while active. `view_image` stays model-only to
  deliver image content directly rather than an empty script value.
- Every subagent tool, including the child's `report`, is model-only.
  `wait_agent` acknowledges completion through a separately persisted tool
  result; a nested-call summary cannot satisfy that contract.
- Subagent acceptance uses Pi's `started` disposition and, for mailbox work,
  the persisted user-message boundary. Handled inputs are not successful tasks.
- Script-callable Codex tools have output schemas and structured results:
  patch `{ summary, files }`, search `{ output, results }`, image generation
  `{ path, latestPath?, image }`. Images require explicit `image(result.image)`
  forwarding. Tool execution failures throw; model-facing content and existing
  renderers remain. Pi deliberately passes structured data through even when a
  `tool_result` hook sets `isError: true`. A hook that needs script rejection
  must also replace `content` without supplying `structuredContent`; changing
  `isError` alone is not a rejection/redaction boundary.
- Children supply builtin codemode/tool-search factories only through Pi's
  normal builtin loader policy. `inheritExtensions: false` prevents loading;
  inherited extension settings may also disable them. Loading does not activate
  them: agent `tools` or Pi `defaultTools` must select them. The supplied child
  codemode factory disables classifier/model calls. Parent `codemode-store`
  custom entries are not inherited by forks.
- Child `tools`/`excludeTools` still constrain the registry, including tools
  registered late. An allowlist grants `codemode`/`deferred` tools callable
  access without forcing declarations; tool search may declare them afterward.
  Those discoveries persist across cold resumes on the child's canonical branch.
  Subagent tools themselves remain model-only. Nested traces retain call
  hierarchy and nested usage is collected from the outer result only.
- While codemode/tool-search is active, prewarm is skipped rather than guessing
  the final `prepareLoadout` projection. Without a native checkpoint, compaction
  delegates to Pi's tool-free text summarizer. With one, recompaction is refused
  without discarding opaque state; disable both tools and retry on the original
  model, or navigate before the checkpoint. This guard recognizes the built-in
  tool names, not arbitrary third-party `prepareLoadout` hooks.
- The packages do not globally enable codemode or inject MCP into children.

OpenAI ChatGPT OAuth and API-key requests now follow Pi's native authentication
and resolved endpoint. Request enhancements and exact endpoint capability
allowlists are configurable; explicit unsupported responses disable only the
affected session/endpoint mode. Neither changes credentials or selects fallback
implementations. See the [configuration guide](../pi-extensions/pi-codex-runtime/reference/configuration.md).

Pi 0.99.1 supplies the descriptors for the exact `openai/gpt-6.1-sol`,
`openai/gpt-6-astra`, `openai/gpt-6-sol` and `openai/gpt-6-luna` profiles.
These use Standard SSE, local custom `apply_patch` (verified grammar capability)
and `view_image` (verified image input). Search, image generation, native
compaction, prewarm and Fast are not enabled by default. Standard Responses
reasoning clamps delegate to Pi; descriptors, limits and prices are not replaced.
The [pinned evidence](../pi-extensions/pi-codex-runtime/provenance/pi-openai-0991-gpt6.json)
does not establish real account access or Codex Lite entitlement.
Unknown IDs remain native; legacy `openai-codex` profiles are frozen and no
`openai-codex/gpt-6.1-sol` profile is added.

## Preserved transcript contracts

The verified `openai-codex/gpt-6-sol` and `openai-codex/gpt-6-luna` Lite
profiles from the prior migration remain unchanged. Pi supplies their descriptors;
this extension does not register them. No family-wide match, fast
billing multiplier or public-API cache TTL is inferred. Package release
eligibility is unchanged. The provider boundary replays
Pi's system sections and tool deltas into the complete prompt/loadout required
by the existing Standard/Lite encoders; the registered shim's native fallback
also receives checkpoint projection. This does not implement in-place delta transport or promise cached
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
On its historical audited versions only, the private `/continue` hook prepares transcript state and delegates run/retry/
abort cleanup to Pi's audited run lifecycle without adding a user message. It
retains recorded prompt sections rather than rebuilding an interrupted turn
from base options, and restores normal preparation before settlement callbacks
and deferred runs. Navigation previews must preserve the effective prefix,
including edits; `--force` cannot restore omitted or replaced content.
Notifications and cleanup remain on `agent_settled`. Real SDK regressions
exercise bounded `agent_before_settle` continuation without adding automatic
parent wakeups or an idle-command replacement.

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
projection. The 0.99.1 target's previously unhashed shrinkwrap artifacts were
checked against registry tarball bytes before recording their SHA-512 values.
Both roles use those exact artifacts. Unknown or conflicting hashes
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
- The private hook is loaded by each baseline's real Pi loader. On 0.99.1 it
  must warn once, register no `/continue`, and leave the `AgentSession` prototype
  unchanged. Historical continuation execution tests are explicitly skipped;
  version guards and pure target-selection tests still run.
- A credential-free offline CLI probe explicitly loads the compatibility bundle.
- Consumer probes run in separate processes to avoid cross-case module globals
  and release temporary installations promptly to bound disk/memory use.
- Provider fixtures normalize contexts before dispatch, like the real SDK.
  Real SDK tests exercise Standard/Lite prompts and dynamic tool changes;
  additional regressions cover compaction checkpoints, inherited system
  authority, continuation after cancellation and JSON argument shapes.
- Native QuickJS tests exercise structured patch/search/image results, image
  forwarding, permission rejection, result redaction and cancellation while a
  nested patch waits on a file queue. Real child SDK tests cover builtin loading,
  deferred discovery, hard registry ceilings and single-counted nested usage.

## Limits and known issues

The configured matrix covers Node 22.19.0 and 24.x against both lock-validation
roles at Pi 0.99.1. It does not claim validation of every future Node or Pi
release or execution of remote GitHub jobs. Older audit records describe the
former 0.84.2/0.85.1 floors and remain historical evidence, not current compatibility.
There are no real account, billable endpoint, interactive UI or publication tests.
Core protocol snapshots remain the repository's reviewed compatibility contract,
not a blanket adoption of upstream protocol/model changes.

The subagent FIFO test intermittently asserted `2 !== 1` during S5. The
[stability follow-up](plans/subagent-fifo-stability.md) identified and corrected
its invocation-order assumption using controlled lookup completion orders.
The runtime queue was not changed; no retry or test-skipping workaround was added.
