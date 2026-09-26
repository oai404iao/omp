# Pi Code Mode — S0–S4

Independent, provider-neutral JavaScript tool orchestration. Ordinary JSON
`exec`/`wait`, cross-turn cells, explicit tool contributions, opt-in local writes
and processes, optional grammar transport/Codex contributions, plus cooperative
`hide-bridged` visibility. **Private/blocked**,
locally installable; not an npm release.
No `pi-codex-*` dependencies, provider replacement, authentication changes
or automatic hiding of unadapted direct tools. JSON and mixed visibility remain
the defaults; Codex integration is optional.

## Requirements and authorization

- Pi >=0.87.0 (development target 0.87.1); Node >=22.19.
- Linux x64 for the official static musl Host (no Host glibc/OpenSSL requirement),
  `/usr/bin/systemd-run`, `/usr/bin/systemctl`, `/usr/bin/env`,
  a user systemd manager and effective cgroup v2 memory/pids/CPU controllers.
  The optional process adapter additionally uses `/bin/bash`.
- A regular (not symlink) executable extracted from the official
  [`rust-v0.157.1` Host archive](https://github.com/openai/codex/releases/download/rust-v0.157.1/codex-code-mode-host-x86_64-unknown-linux-musl.tar.gz),
  SHA-256 `67b86142bac5cead11b8420cf32d3a2bf88c8868d71733f351ed7c5d95a953e0`.
  Archive SHA-256: `3516f9b8bbe6bc06ee7bdb92b293a17eab194b3f10b9b9ea10c5b839e972d7fc`.
  Exact source/artifact metadata lives in `src/host-manifest.json`; see
  `THIRD_PARTY_NOTICES.md`. The release includes the upstream V8 array-sort
  optimization workaround; no local patch/build is needed. Older official
  binaries and the former local GNU build are rejected. Digest verification
  is not signature verification or a general security certification.
  No automatic download/fallback.

```sh
pi -e ./pi-extensions/pi-code-mode \
  --code-mode-host /absolute/path/to/extracted/pinned-host
```

`/code-mode on` asks for a session-local cwd read grant and shows any additional
capabilities selected by CLI flags. `/code-mode off` revokes and stops work;
`/code-mode status` reports grants; `/code-mode cells` lists retained IDs/states.
`/code-mode terminate <id>` requests precise termination; `terminate all` requests
all cells atomically. Bare `terminate` requires exactly one retained cell (or an
active doctor probe). Commands do not consume output/usage: use `wait` to settle.
Loading alone grants nothing and starts no Host.

## User configuration and diagnostics

Optional `<agentDir>/extensions/pi-code-mode/config.json`:

```json
{
  "version": 1,
  "hostPath": "/absolute/path/to/codex-code-mode-host-x86_64-unknown-linux-musl",
  "protocol": "auto",
  "visibility": "mixed",
  "maxCells": 1,
  "requiredPolicies": []
}
```

Defaults < user config < explicit CLI < current-session commands. Reload reads
the file and CLI again; commands do not save changes. Unknown keys/version/types
fail closed. There is no project-level config or persistent grant in this file:
`readRoot`, `write`, `process` and external `tools` are deliberately rejected.
With hostPath configured, `/code-mode on` can ask for a current-session grant.
`maxCells` is an integer 1–4, default 1; opt into two cells with `"maxCells": 2`
or `--code-mode-max-cells 2`. This changes shared Host slots, not authority.

`requiredPolicies` lists at most 16 distinct, exact policy IDs, for example
`["permission__guard"]`. It only restricts admission, never grants tools.
Missing, failed, incompatible or not-ready required policies prevent **all**
nested work (including local adapters) before a Host/cell is started.
Policy IDs can be a single existing identifier or `owner__policy`; no wildcards.
Discovery failures also cancel retained cells and release cooperative hiding.
This protection requires the I0-capable consumer; an old v1 consumer cannot
infer that an absent extension was required. There is no transparent downgrade
for configurations requiring this guarantee.

`/code-mode doctor` checks the pinned file/hash/platform, user systemd manager,
available controllers, configured protocol and available/granted contributions.
It starts no Host, downloads nothing and grants nothing. Static controller
availability is not an enforcement proof. `/code-mode doctor host` additionally
runs an isolated, supervised `1+1` check with no nested tools, then stops that
Host; it does not enable normal Code Mode or use provider credentials.
`off`/`terminate`, context replacement and shutdown cancel an in-flight doctor
probe; shutdown waits for its separate Host cleanup.
Diagnostics report **configuration/CLI**, not unsaved protocol command overrides;
`/code-mode status` reports the live runtime selection.

For headless use, explicitly authorize cwd:

```sh
pi -e ./pi-extensions/pi-code-mode \
  --code-mode-host /absolute/path/to/extracted/pinned-host \
  --code-mode-read-root "$PWD" -p "Use exec to inspect the source"
```

Independent **additional** flags:

| Flag | Authority |
| --- | --- |
| `--code-mode-read-root "$PWD"` | Reads including hidden/sensitive files; root must resolve to cwd |
| `--code-mode-write` | Atomic file create/replace within that root |
| `--code-mode-process` | **Full current-user local shell authority**, including writes outside root |
| `--code-mode-tools owner__tool,owner__another` | Exact external contribution grants; no wildcards or root confinement |

`--code-mode-visibility mixed|hide-bridged` controls presentation, **not grants**.
It defaults to `mixed`; `/code-mode visibility mixed` or
`/code-mode visibility hide-bridged` changes it for the current runtime without
changing permissions or cancelling a cell. Reload starts from the CLI flag again.

Write/process/contribution flags alone do not enable Code Mode. Grants are
not inferred from project trust, direct tool visibility or persistent config.
Headless authorization is explicitly supplied on the CLI; missing prerequisites
fail closed. Existing `exec` or `wait` owners are never replaced.

## Model tools and cells

```ts
exec({ code: string, yield_time_ms?: number, timeout_ms?: number, max_tokens?: number })
wait({ cell_id: string, yield_time_ms?: number, max_tokens?: number, terminate?: boolean })
```

`exec` starts one cell. `yield_time_ms` is an observation window (default 1000,
range 0–30000 ms), **not** a cell deadline. `timeout_ms` sets the cell's total
deadline, default/max 300000 ms, and may only reduce it. `wait` never extends it.
`max_tokens` (1–8192, default 8192) is a **four UTF-8 data bytes per token
estimate**, not tokenizer accounting or a limit on status/trace metadata.

Each response includes an opaque `cm-…` cell ID, state, bounded data and details.
Details include wall time, cumulative Host-operation nanoseconds (not CPU time),
origin tool call, epoch, error kind, runtime-reset/Host-completed flags and changed
nested traces with queue/start/settle timestamps. Traces contain no arguments or
results. At most 32 entries with bounded names/IDs are paged within a 16 KiB trace
budget; `hasMoreTraces` requires another wait before the ID is consumed.
Later observations omit unchanged entries. Observation abort consumes none.
States: `running`, `awaiting_approval`, `settling`, `terminating`, `completed`, `terminated`, `failed`.
Use `wait` while nonterminal and while `hasMoreOutput` is true. Output pagination
preserves whitespace and Unicode boundaries. A terminal result with all output
and traces collected consumes the ID and releases a slot. Terminal unread cells
still occupy capacity. A full/blocked error includes all retained IDs, including
after a cancelled initial observation. Default capacity 1 preserves serial use;
opt-in cells share ONE Host, volatile store and execution scheduler.

Only one public observer **per cell** is permitted. Cancelling an observation consumes
nothing and does **not** itself kill the cell. Pi agent interruption/Esc cancels
all session cells separately, even after `exec` returned. Normal `agent_end` does
not: cells can continue across model turns and later user prompts.

Code Mode contributes stable instructions through Pi's `code_mode` system-prompt
section, without forcing a replacement for the full prompt. Current cell IDs and
state remain in `exec`/`wait` results and `/code-mode cells`, not in per-turn prompt
text. Disabling or losing availability removes the section on the next prompt.
Recorded sections are model context, never authority to restore grants or cells.
Another extension's explicitly forced prompt still takes precedence.

`wait({cell_id,terminate:true})` first stops dispatch and aborts nested work,
then terminates the Host cell and waits for already-started effects to settle.
`terminating` is not a claim of cleanup. An explicit successful termination
is not an execution error; deadline/agent interruption is. An unconfirmed
process stop poisons the session and blocks later side effects/new cells.
Unresponsive I/O or noncooperative contributions can delay settlement.

Every cell gets a fresh JS environment. `store(key,jsonValue)` and `load(key)`
share only volatile Host JSON state, bounded by Host memory. Normal termination
discards that cell's pending store writes and preserves earlier committed data.
Each cell reads its own initial snapshot; successful completion merges only keys
it wrote. Concurrent writes to the same key follow actual commit order, not
invocation order. This is not a transaction or live shared JS object.
Cancellation racing an already-completed Host result cannot undo its commit.
Script/protocol failure, OOM or a hard watchdog resets ALL still-active siblings
and the shared store. A normal targeted cancellation does not reset siblings.
No replacement Host/effects are admitted while the failed epoch still settles.
Model change, tree navigation,
session replacement, reload, contribution refresh/disposal and off also reset it.
Five minutes idle (after all IDs are collected) or one hour Host lifetime loses
it too. Reload never restores
an old ID or replays code; explicit CLI grants may authorize the new session.

```js
const results = await Promise.all(
  ["package.json", "README.md"].map(path => tools.read({path}))
);
store("previews", results.map(result => result.text.slice(0, 200)));
text(load("previews"));
```

Only explicitly emitted `text(value)` reaches model-visible business output.
The supported Host helpers also include `ALL_TOOLS` (authorized name/description
metadata), `setTimeout`/`clearTimeout`, `yield_control()` and `exit()`.
Await timers explicitly; pending callbacks alone do not keep a cell alive.
`yield_control()` flushes to the Host observation path, not an immediate new Pi
turn or extended deadline. `exit()` ends the script successfully; await effects
first. These helpers do not expose ungranted tools.
Image/audio/notification helpers, arbitrary imports, direct filesystem/network
APIs and automatic wrapping of arbitrary Pi tools are unsupported.
Script failures are real Pi error results, retaining partial data/usage.
Text overflow instead retains a UTF-8-safe prefix, marks `truncated/droppedBytes`,
stops dispatch and terminates/settles the cell. It remains a failure; a later user
terminate cannot turn it into success. Discarded bytes are not `hasMoreOutput`.
Once settlement is confirmed, this path can keep the Host and earlier store.
If `hostCompleted` is already true, that cell's store writes may have committed.
Script errors, unsupported content and unexplained protocol/MissingCell failures
still reset the runtime/store. Unconfirmed Host or process stop blocks reuse.

## Protocol and provider switching

`--code-mode-protocol json|auto|grammar` defaults to `json`.
`/code-mode protocol json|auto|grammar` changes the current runtime without
resetting cells, store or grants; reload returns to the CLI value.
`wait` is always a JSON tool.

- `json`: ordinary function tool on any compatible Pi provider.
- `auto`: grammar only for OpenAI Responses/Codex Responses/Azure Responses/
  Completions APIs with model `compat.supportsOpenAIGrammarTools === true`.
  Otherwise JSON, including unsupported custom transports.
- `grammar`: the same capability checks, but failure blocks `exec` **before
  starting a Host**, rather than silently downgrading. `wait` remains available.

Custom provider streams opt in on synchronous `transport/v2` (under the
`@oai404iao/pi-code-mode:` prefix). Payload `{protocol:2,accept}` accepts a
capability with the **exact registered active `streamSimple` function**,
`input:"pi-transcript/1"`, `formats:["json","grammar"]`, a projection
(`"effective-checkpoint"` or `"transcript-deltas"`), and verified semantics
`sections`, `tool-removal`, `tool-redefinition`, `forced-prompt`,
`compaction-checkpoint`, `exec-history`. There are at most 16 replies.
Codex advertises effective-checkpoint projection, not cached-prefix preservation.
Missing v2 matches may use the audited `transport/v1` exact-stream handshake
(`{version:1,accept(stream)}`); a conflicting or incomplete matching v2 declaration
cannot downgrade through its v1 mirror. Both legacy and native Provider
registrations are checked; a provider-name match alone is insufficient.
Native Pi adapters require no extra handshake. This is an interoperability
contract among trusted extensions, not an isolation boundary.

Grammar `exec` takes raw JavaScript, not a JSON wrapper or Markdown fence.
Its canonical Pi argument remains `{code:string}`. Optional controls use a
first-line pragma:

```js
// @exec: {"yield_time_ms":0,"timeout_ms":30000,"max_tokens":1024}
text(await tools.read({path:"README.md"}));
```

The pragma requires a newline and nonempty JavaScript body. Unknown options,
invalid ranges and conflicting outer JSON controls fail before execution.
The 24 KiB code budget includes the pragma. The Lark grammar accepts nonempty
raw source; it is **not** a JavaScript syntax validator or security sandbox.
Syntax/runtime checks and resource limits still belong to the supervised Host.

On grammar requests, a public `context` hook projects historical JSON exec
controls into that raw representation. Saved calls, results and IDs are never
mutated; existing raw inputs remain byte-for-byte identical, and code is never
re-executed to rebuild history. Incompatible historical exec arguments cause
auto to use JSON and forced grammar to refuse: select JSON or a clean branch.
Switching back to JSON/Anthropic keeps canonical arguments; model changes still
reset volatile cells/store according to the lifecycle above.

## Optional Codex contributions

### Explicit nested approval

Tools and policies can declare `approval: "user"` (or a custom provider ID).
Register custom providers with `registerCodeModeApproval(pi, { id, approve })`
from the public `/contributions` export. Discovery uses `discover/v2` with an
`approvals/v1` mirror; disposal invalidates old cell snapshots.
Missing providers, denial, exceptions, non-`true` results and cancellation fail
closed. No approval is implicitly added to existing grants/tools.

The registration helpers now negotiate `approval/1` through a separate
`discover/v2` channel. Older v1 consumers receive only approval-free tools;
an approval-dependent global policy supplies a v1 `before` deny guard instead
of disappearing. The current consumer accepts the audited v1 baseline too.
Exact per-discovery registration receipts suppress duplicate legacy mirrors;
receipts are neither grants nor approval decisions. Semantic refresh first
withdraws the old offer and notifies v1 consumers, then publishes a new revision.
Do not mutate a registered tool/policy in place.

V2 also supports general `requires` and availability declarations, stable
consumer-instance generations, registration revision checks and classified
refresh. User-configured `requiredPolicies` supplies
the independent expectation needed when a producer never loads or throws before
offering its guard. Global policy readiness failures reject the entire catalog,
even when not explicitly listed; a missing policy's former presence alone is not
a durable expectation.

Order: normalize/freeze/validate → before policies → deduplicated approvals →
execution scheduler → invoke → after policies. Approval sees the same frozen
final arguments as invocation. It does not acquire a worker or the write gate.
One session owns a FIFO queue (16 pending maximum); aborted active dialogs keep
their slot until the provider actually settles. A stuck dialog blocks new work,
not a second overlapping prompt. Refresh/off/model/tree invalidate late approval.

The built-in `user` provider uses Pi `ui.confirm` with the cell's abort signal;
headless execution cannot silently approve. Large argument previews are bounded
and show full byte length/SHA256; approval authorizes the entire hashed input.
`awaiting_approval` is visible in observations/traces. Positive-yield observations
hold for an outstanding human prompt (up to cell cancellation/deadline), rather
than generating polling tool calls; zero-yield remains nonblocking. Do not
re-execute or bypass a pending approval. This is not a forged native Pi hook.

Install the owners separately and grant exact names, for example:

```sh
pi -e ./pi-extensions/pi-codex-core -e ./pi-extensions/pi-codex-web-search \
  -e ./pi-extensions/pi-code-mode \
  --code-mode-host /absolute/path/to/extracted/pinned-host \
  --code-mode-read-root "$PWD" --code-mode-protocol auto \
  --code-mode-tools codex_core__apply_patch,codex_web__web_search
```

- `tools.codex_core__apply_patch({input})`: exclusive write contribution using
  the owner's existing executor and Pi's cooperative file mutation queue.
  **Not confined to the Code Mode read root.** Aborts are checked before entering
  queued work; entered effects must settle and are not cancelled/rolled back
  merely because observation stopped.
- `tools.codex_web__web_search(...)`: parallel read contribution only on the
  owner's configured **standalone** profiles, using existing Pi authentication
  and alpha/search client. Identity and conversation tail are captured before
  auth I/O. Missing auth is an error, never a fallback account.

Installation alone grants nothing. No dependency in either direction connects
these packages to Code Mode; they use the versioned contribution event protocol.
Nested policies and cancellation still apply, not native direct-tool hooks.
Hosted placeholders, `view_image` and `image_generation` remain direct: their
multimodal/control contracts are not silently converted to text.
These Codex contributions now offer cooperative direct bindings: `hide-bridged`
hides explicitly granted patch/standalone-search counterparts. Owner activation
still determines logical availability; hosted/image tools are never claimed.

## V2 author contract

The public `/contributions` export includes `ConsumerHello`, `Registration`,
`DiscoveryOffer`, `DiscoveryReceipt`, `Availability`, `ContributionChange` and
`FEATURES`. Providers and individual tools may declare `requires: ["feature/1"]`
and `availability: {state,reason?}`. States are `available`, `unavailable`,
`not-ready`, or `failed`. Tool-level `requiredPolicies` restricts admission to
those exact guards; it never grants tools. Policies may also require features.
`/code-mode tools` and `/code-mode doctor` show availability/compatibility and
exact grant status without dumping unauthorized schemas into model prompts.

Consumer IDs persist only for the current extension instance. Generations
advance on authority/lifecycle changes; new/resume/fork/reload instances get new
IDs. Receipts remain per-discovery object evidence and are never persisted.
Registration revisions cannot roll back, including across unavailable offers;
same-revision executable replacement is rejected. The bounded history accepts
at most 256 registration identities per consumer instance, and helpers track at
most 64 consumer instances. Collection accepts at most 32 providers, 64 total
tool declarations (including unavailable ones), and 16 each of policy, approval
and observer records. Duplicate/conflicting mirrors fail closed.

Helper tool registrations expose `refresh(tools, "presentation")` for changes
limited to descriptions/output hints. Executable schema, effects, requirements,
prepare/invoke functions and direct binding identities cannot change through
that path. The consumer also compares executable snapshots rather than trusting
the event label. Default `refresh(tools)` remains an execution change.
To update provider-wide requirements or availability, pass a replacement
`{id,tools,requires?,availability?}` instead of the tools array; `id` must stay
unchanged. Do not mutate the previous declaration in place.
`changed/v2` reports registration, kind and phase; helpers also emit the v1
invalidation required by legacy consumers. Execution/policy/approval changes
revoke synchronously and coalesce teardown, while diagnostics/presentation
preserve live cells and store. Disposed observers stop receiving new receipts.
Unclassified legacy changes remain conservative full invalidations.

Owners that cannot confirm effect settlement must throw `unsettledEffect(message)`
from `/contributions`. Across physical installations its structural discriminator
is `{code:"PI_CODE_MODE_UNSETTLED_EFFECT",version:1,message:string}`; matching
does not depend on `instanceof`. It blocks queued effects and poisons the session.
This also applies to `prepare`, policy and approval failures, including late
rejections after cancellation. A synchronous preflight failure closes admission
before another invocation can start.
Do not use it for ordinary failures whose effects have settled. Result adapters
must explicitly return `{value,usage?}` with bounded JSON, not blindly expose
native `details`, drop media, or swallow agent-control results.

The Codex structural client implements v2 plus a legacy-safe v1 mirror without
a dependency on this private package. The standalone inventory example below
demonstrates a v2-only owner; an old consumer leaves it direct rather than
guessing an equivalent nested executor.

## Explicit I3 pilots (off by default)

```sh
pi -e ./pi-extensions/pi-code-mode \
  -e ./pi-extensions/pi-code-mode/examples/inventory.ts \
  -e ./pi-extensions/pi-code-mode/examples/pi-builtin-ls.ts \
  --code-mode-host /absolute/path/to/pinned-host \
  --code-mode-read-root "$PWD" \
  --code-mode-tools inventory__lookup,pi_builtin__ls
```

- `inventory.ts` is a standalone extension with no Code Mode import or
  dependency. Its direct `inventory_lookup` and nested `inventory__lookup` share
  the same in-memory query and validation. It stays direct without Code Mode.
- `registerPiBuiltinLs(pi)` from `/builtin-adapters` explicitly installs the
  `pi_builtin__ls` contribution. Importing the main extension does not install
  it; registration does not grant it. It creates Pi's **local builtin** ls for
  the invocation cwd; it does not call, hide or replace a registered ls/SSH/
  sandbox override, and does not inherit Pi hooks or Code Mode root confinement.
  The exact grant permits current-user local listing, including absolute paths
  outside the root. Defaults are 500 entries/50 KB; mapping preserves text,
  entry limits and truncation counters without exposing arbitrary `details`.
  The bridge's separate JSON byte budget still applies.

No find/grep/read adapter, media adapter, or subagent query/control adapter is
installed by these pilots.

## Local adapters

- `tools.read({path,offset?,limit?})`: regular-file UTF-8 read, zero-based byte
  offset, at most 32768 bytes. Returns `{text,nextOffset,truncated}`. Partial
  source-file UTF-8 sequences use replacement characters.
- `tools.ls({path?})`: default `"."`; up to 200 sorted entries in a bounded subset,
  returns `{entries:[{name,type}],truncated}`; not recursive/paginated enumeration.
- Opt-in `tools.write({path,content})`: at most 128 KiB UTF-8 content, existing
  parent directories required. Returns `{path,bytesWritten,committed:true}`.
  Uses an anchored temporary file, sync and atomic rename, preserves existing
  mode and participates in Pi's cooperative per-file mutation queue.
- Opt-in `tools.bash({command,timeout_ms?})`: command at most 12 KiB; timeout
  default 30s, max 300s, additionally bounded by the cell deadline.
  Returns `{stdout,stderr,exitCode}`; a nonzero exit is data, not a bridge error.
  Combined stdout/stderr at most 32 KiB; overflow/timeout fails the call.

Local file traversal is descriptor-anchored with `O_NOFOLLOW`; paths outside
root, symlink components and observed nonregular endpoints are refused.
Atomic replacement never follows the destination symlink. This is not an OS
filesystem sandbox or protection against another process with the same UID.
Root writes do not create directories or provide edit/patch semantics.

Process jobs have their own verified cgroup and independent watchdog. A gate
permits the user command only after enforcement verification. The shell receives
HOME/TMPDIR/PATH/LC_ALL, not inherited provider credentials or shell init files.
**Commands still have full current-user filesystem/network authority**, can
read credentials from disk, contact external services and cause effects outside
the supervised process tree. Resource supervision is not a security sandbox.
Files/processes/network actions are never rolled back.

## Contributing tools and policies

Tools belong to their extensions. Register a data-returning adapter using the
public subpath; do not scrape Pi private registries:

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { registerCodeModeTools } from "@oai404iao/pi-code-mode/contributions";

export default function extension(pi: ExtensionAPI) {
  const registration = registerCodeModeTools(pi, {
    id: "inventory",
    tools: [{
      name: "lookup",
      description: "Look up inventory by ID",
      parameters: Type.Object({ id: Type.String() }, { additionalProperties: false }),
      effect: "read",
      parallel: true,
      async invoke(input, context) {
        context.signal.throwIfAborted();
        const { id } = input as { id: string };
        return { value: { id, available: true } };
      },
    }],
  });
  pi.on("session_shutdown", () => registration.dispose());
}
```

Grant `--code-mode-tools inventory__lookup`; JS sees
`tools.inventory__lookup({id:"item"})`. Provider/tool components are 1–40
characters matching `^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$`: no double/trailing
underscores. Names are unambiguous, and duplicate owners/names fail closed.

`registerCodeModeTools` returns `refresh(tools)` and `dispose()`.
Versioned `pi.events` discovery is synchronous, independent of load order.
Each cell captures immutable schema/tool/policy records; refresh/disposal cancels
and resets the old cell before updating the actual model-visible exec catalog.
Callbacks are trusted extension code: do not mutate captured behavior secretly.
Helpers create no Host/background resources.

Exec's catalog uses bounded TypeScript-style signatures rather than full JSON
Schema. These are display hints, not TypeScript execution or new validation:
Common integer/range/length/pattern constraints and descriptions are shown in
bounded annotations; all constraints still apply through the original schema.
Unsupported/recursive/deep types fall back conservatively to `unknown`.
An owner may supply optional `outputSchema` (8 KiB, cloned/frozen) for the return
hint; without it the return type is `unknown`. It is descriptive metadata, not
a replacement for finite-JSON/result limits or a promise of result validation
against that output schema. Inner input schemas are not sent redundantly to a
Host that discards them; the Pi bridge keeps and validates the originals.

`effect` is `read|write|process`; only explicitly `parallel:true` reads overlap.
Writes/processes and unspecified parallelism are exclusive FIFO barriers.
The four-worker, sixteen-queued scheduler is **session-wide across all cells**, not a global
lock against direct Pi tools or external processes.

### S4: cooperative direct-tool visibility

`hide-bridged` suppresses only a direct counterpart whose owner explicitly offers
a binding on an **authorized** contribution. A contribution without a binding
stays usable through JS, but cannot hide any Pi tool. In particular, independent
local `tools.read/write/bash` adapters are **not** evidence that Pi's current
read/write/bash implementation is equivalent; those Pi tools remain untouched.
Codex owner activation cooperates through an optional versioned factory bus,
without importing this private package. A unique registered schema reference
proves the actual owner before binding; foreign first-registration winners and
replacements are not claimed. Without Code Mode, normal activation is unchanged.

The owner uses `createCodeModeDirectBinding`, exported from the same
`@oai404iao/pi-code-mode/contributions` TypeScript subpath (load via Pi's extension
loader, not bare Node node_modules type stripping):

```ts
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  createCodeModeDirectBinding, registerCodeModeTools,
} from "@oai404iao/pi-code-mode/contributions";

export default function inventory(pi: ExtensionAPI) {
  const parameters = Type.Object({ id: Type.String() }, { additionalProperties: false });
  const lookup = async (id: string, signal?: AbortSignal) => {
    signal?.throwIfAborted();
    return { id, available: true };
  };
  pi.registerTool({
    name: "inventory_lookup", label: "Inventory",
    description: "Look up inventory by ID", parameters,
    async execute(_id, args, signal) {
      return {
        content: [{ type: "text", text: JSON.stringify(await lookup(args.id, signal)) }],
        details: {},
      };
    },
  });
  const visibility = createCodeModeDirectBinding(pi, {
    name: "inventory_lookup",
    sourcePath: fileURLToPath(import.meta.url),
  });
  const registration = registerCodeModeTools(pi, {
    id: "inventory",
    tools: [{
      name: "lookup", description: "Look up inventory by ID", parameters,
      effect: "read", parallel: true, direct: visibility.binding,
      async invoke(input, context) {
        return { value: await lookup((input as {id: string}).id, context.signal) };
      },
    }],
  });
  // Route your existing activation policy through this method, including
  // model/thinking hooks. true is this example owner's policy, not a mandate.
  pi.on("session_start", () => { visibility.setActive(true); });
  pi.on("session_shutdown", () => {
    registration.dispose();
    visibility.dispose();
  });
}
```

With `--code-mode-tools inventory__lookup --code-mode-visibility hide-bridged`,
the nested adapter remains in exec's catalog while `inventory_lookup` is removed
from the active tool definitions. It is still registered in `getAllTools()`.
Changing visibility is not a tool invocation and does not grant new capabilities.

Owner contract:

- `sourcePath` must equal Pi's exact `sourceInfo.path` for the owning extension.
  Use its entry file, not an imported helper file. Named inline factories use
  their public `<inline:name>` source path. Builtin/SDK sources and `exec/wait`
  cannot be claimed by this helper.
- Route **all owner activation/deactivation** through `setActive(boolean)`.
  While suppressed, it records the owner's latest desired state; auto-enable
  hooks cannot fight the lease. No global interception is installed.
- Call `reconcile()` immediately after owner-controlled `registerTool` or
  other registry refreshes; it announces readiness through the versioned
  visibility bus so previously absent direct tools can join. Contribution
  registration/refresh/disposal continues to use S2's lifecycle protocol.
- Dispose the old handle before replacing direct-tool semantics; make a new
  handle and `registration.refresh()` the matching nested adapter. Public
  metadata fingerprints reject detectable definition/source replacement.
  **Pi has no public registration identity**: same-source, identical-metadata
  replacement is indistinguishable. Owners must cooperate even in that case.
- Bindings/leases are synchronous; do not implement asynchronous visibility
  callbacks. Helpers start no Host, process or timer.

Only lease-owned removals or later owner activation intents are restored,
merged into the **current** active set. Initially inactive tools stay inactive;
unrelated additions/removals survive. Off, switching to mixed, contribution
removal, owner disposal and shutdown/reload release leases; reconciliation also
releases leases when execution is permanently blocked. Definition replacement
is never re-enabled by an old receipt.
Cleanup attempts all owners; failures are reported and retained for retry rather
than silently claiming restoration succeeded.

Same-instance `/tree` replay does not replace explicit owner intent. Live leases
stay hidden, current explicit inactivity wins over historical activation, and
released restoration survives historical omission. Codex also recomputes current
profile restrictions and native edit/write suppression. This does not persist
intent or authority across new/resumed/forked/reloaded extension instances.
Failed owner disposal retains tree observation and its release receipt, while
closing controls/factories refuse new acquisition. Factory capacity counts live
controls rather than historical allocations.

Factory shutdown closes **every** control before any restoration callback.
Independent owners and native suppression restoration are attempted even when
one receipt fails. Failed receipts retain a retry path after foreign replacement
as well as during shutdown; success is not reported for partial cleanup.

Code Mode's own exec/wait registrations use instance-local schema references
and live source/metadata fingerprints. Matching descriptions or cloned historical
declarations cannot claim ownership, refresh a replacement, or toggle it.

Pi 0.86.1 has no active-tools-changed event or global visibility lock.
`registerTool` may reactivate names selected by `--tools`; reload re-enables
extension definitions. Owner `reconcile()` and Code Mode's pre-request-safe
boundaries reapply suppression. `turn_start/context` are **after** Pi snapshots
tools and cannot fix the current request. Noncooperating later writers can
still re-enable names; `/code-mode status` reports observed hidden/reactivated
names, not an absolute guarantee.

Tool removals may disable native deferred-loading/cache-prefix optimization;
Pi then sends the normal current tool list. Visibility does not rewrite provider
payloads, `addedToolNames`, or conversation history. S3's outgoing exec-argument
projection does not modify the saved transcript. Hiding does not erase old
tool mentions, enforce permissions, block arbitrary direct calls from trusted
extensions, or imply native Pi guards cover nested adapters. **Strict `only`
is not implemented** and is rejected, rather than silently approximated.

Top-level missing/undefined/null input is normalized to `{}` because Host V1
cannot distinguish them and contributions require object schemas. Field-level
null is unchanged; required properties still validate. `prepare(input)` then
optionally normalizes arguments, and cloned/frozen final
arguments are schema-checked and supplied to ordered policies and `invoke`.
Invocation context supplies `cellId`, `toolCallId`, cwd, per-invocation signal,
and current Pi context with that signal. Never retain it across invocations.
Adapters must honor abort and await their real effects before resolving.

`registerCodeModePolicy(pi,{id,before?,after?})` returns a disposer.
`before(call)` may return `{block:true,reason?}`; rejection/throw/timeout aborts
before invocation. `after(call,value)` returns redacted JSON before JS sees it.
Hooks run in sorted policy-ID order, with frozen data and a five-second signal
budget. They must cooperate with cancellation; use policy hooks for checks/
redaction, not independent side effects. Abort/timeout rejects the JS binding
promptly, but an entered hook remains part of the invocation until its actual
promise settles. An exclusive invocation retains its scheduler slot through
that cleanup; cell completion and diagnostic receipts also wait. Late values
cannot resume execution or bypass redaction. Ordinary cooperative cleanup does
not poison the session; an explicit unsettled-effect rejection does. A hook
that never settles can keep a cell nonterminal and trigger the existing blocked
teardown path. Discovery caps: 32 providers, 64 tools,
16 policies; schema 8 KiB, description 2000 characters, entire catalog 24 KiB.

For initialization that can fail, use
`registerCodeModePolicy(pi, {id, resolve() { return {id, before, after}; }})`.
Resolution is synchronous and performs no I/O. The helper announces not-ready
before resolving and converts failures to a bounded failed record; it does not
rely on Pi propagating event-listener exceptions. Legacy consumers receive a
deny guard for this resolver form. The callable disposer also has `refresh()`:
call it after changing policy semantics/readiness, before allowing further
effects; it withdraws the old revision and emits v1 revocation before publishing
the next one. Do not silently mutate guards captured by running cells.
Use `requiredPolicies` in addition to this helper to cover a missing producer.

`registerCodeModeObserver(pi,{id,complete(receipt,signal)})` returns a disposer.
This is a separate, optional diagnostic protocol (at most 16 observers), **not**
a permission/redaction hook. Frozen receipts include IDs, names, state and
timestamps, never inputs/results. Callbacks must be read-only and honor their
five-second signal budget; they do not delay tool delivery or modify results.
Failures increment diagnostic counts when still observable and emit an ID-only
stderr warning; late failures are not durable audit receipts. Do not use these
callbacks for effects or guaranteed delivery. Registration/disposal uses the same
catalog invalidation lifecycle. Security `after` policies still fail closed.

**Nested adapters do not trigger Pi `tool_call/tool_result` hooks.** Existing
Pi permission/redaction plugins, SSH/container overrides and current direct
tool implementations are not inherited. Only outer `exec`/`wait` use those
hooks. Contribute equivalent behavior explicitly; visibility is not authority.

### Results and accounting

An invocation returns `{value: JsonValue, usage?: Usage}`. Values must be plain,
acyclic finite JSON (64 KiB, depth 64, 10000 nodes). Native `usage` is validated,
aggregated and attached once to the next delivered exec/wait observation, even
if later processing fails. Cancelled observations consume neither data nor usage.

Pi `terminate`, `addedToolNames` and arbitrary envelope fields are explicitly
**unsupported**, not silently ignored. Keep tools relying on those controls
direct. No image/multimodal conversion or automatic tool activation is implied.

Collect results before off/reload. Discarded usage becomes an audit-only
`pi-code-mode:uncollected-usage/v1` session entry, **not** invented Pi totals.
After a five-second teardown settlement timeout, the session remains blocked.
Late receipts are audited on settlement; if the old Pi runtime is already stale,
the receipt is printed to stderr instead of modifying a replacement session.
This fallback is not durable storage. Parent death/nonreturning extensions
cannot provide a final receipt or guaranteed in-process cleanup.

## Resource budgets and verification

| Budget | Enforcement |
| --- | --- |
| Host / each process job | 192 MiB memory, swap 0, 64 tasks, one CPU |
| Cell | At most 300s parent deadline + independent OS timer, at most 305s |
| Host lifetime | 1h OS watchdog; whole-cgroup termination |
| Code / IPC frame / cell text | 24 KiB / 1 MiB / 32 KiB |
| Cell slots | 1 default, explicit 1–4 |
| Calls per cell / shared active workers / shared queued jobs | 32 / 4 / 16 |
| Maximum aggregate cell text / calls at four slots | 128 KiB / 128 |
| Bridge result / local write | 64 KiB / 128 KiB |

The IPC ceiling accommodates worst-case JSON escaping of bounded writes; it is
not a larger output allowance. Kernel limits and PID membership are verified
before code/commands run. Unknown stop state retains the OS watchdog and blocks
reuse; killing a proxy is not proof that effects ended.

Verified binaries share one private, content-addressed cache under
`${XDG_STATE_HOME:-$HOME/.local/state}/pi-code-mode/hosts/` (about 74 MB per pinned
artifact), while each Host/process retains a separate working directory.
The caller's executable and cached bytes are stream-hashed on **every** launch;
publication is atomic and never replaces an existing cache inode. Symlinks,
insecure cache directories and mismatches are refused, not silently repaired.
This protects normal cooperating launches, not a malicious process with the same
UID modifying files after verification. Remove only specific inactive directories
manually; old per-runtime copies are not automatically swept.
No authorization config or transcript is stored there.

Performance evidence can be reproduced with
`npm exec -- tsx scripts/benchmark-code-mode.mts --host /absolute/path/to/pinned-host`.
The bounded five-sample workload reports latency/RSS/disk/IPC/systemd counts.
Caching reduces retained disk and streaming limits transient buffers, but extra
verification can increase cold-start latency; no universal speedup is promised.

```sh
npm run check --workspace @oai404iao/pi-code-mode
CODE_MODE_TEST_HOST=/absolute/path/to/pinned-host \
  npm run test:host --workspace @oai404iao/pi-code-mode
npm run test:code-mode-package -- --host /absolute/path/to/pinned-host
npm run test:code-mode-package -- --host /absolute/path/to/pinned-host --codex
```

Host tests require the real executable/systemd and fail rather than silently
skip prerequisites. Native OpenAI Responses/Completions, Anthropic and Codex
Standard/Lite tests use real Pi adapters with fixture HTTP or loopback WebSocket,
**not live provider accounts**. Current pin and settlement verification:
[`official Host audit`](../../docs/audits/pi-code-mode-official-host-settlement.md).
Earlier scope and evidence:
[`S2 audit`](../../docs/audits/pi-code-mode-s2.md) and
[`S4 audit`](../../docs/audits/pi-code-mode-s4.md), plus the
[`S3 audit`](../../docs/audits/pi-code-mode-s3.md) for actual evidence and remaining
limitations.
