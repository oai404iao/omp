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

- Pi 0.85.1 or compatible; Node >=22.19.
- Linux x64, `/usr/bin/systemd-run`, `/usr/bin/systemctl`, `/usr/bin/env`,
  a user systemd manager and effective cgroup v2 memory/pids/CPU controllers.
  The optional process adapter additionally uses `/bin/bash`.
- An extracted, regular (not symlink) executable for `codex-code-mode-host`
  `rust-v0.145.0`, SHA-256
  `60bf16414be5333f09ff082540082304c7352931ef64bdeb170d4c35a82e6ef8`.
  Asset URL/hash/license are pinned in `src/limits.ts` and
  `THIRD_PARTY_NOTICES.md`. No automatic download or unsafe fallback.

```sh
pi -e ./pi-extensions/pi-code-mode \
  --code-mode-host /absolute/path/to/extracted/pinned-host
```

`/code-mode on` asks for a session-local cwd read grant and shows any additional
capabilities selected by CLI flags. `/code-mode off` revokes and stops work;
`/code-mode status` reports grants and the current cell;
`/code-mode terminate` requests termination (may still need `wait` to settle).
Loading alone grants nothing and starts no Host.

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
States: `running`, `settling`, `terminating`, `completed`, `terminated`, `failed`.
Use `wait` while nonterminal and while `hasMoreOutput` is true. Output pagination
preserves whitespace and Unicode boundaries. A terminal result with all output
collected consumes the ID; only then may another `exec` start. A busy error
includes the retained ID, including after a cancelled initial observation.

Only one public observer is permitted. Cancelling an observation consumes
nothing and does **not** itself kill the cell. Pi agent interruption/Esc cancels
the cell separately, even after `exec` returned. Normal `agent_end` does not:
the cell can continue across model turns and later user prompts.

`wait({cell_id,terminate:true})` first stops dispatch and aborts nested work,
then terminates the Host cell and waits for already-started effects to settle.
`terminating` is not a claim of cleanup. An explicit successful termination
is not an execution error; deadline/agent interruption is. An unconfirmed
process stop poisons the session and blocks later side effects/new cells.
Unresponsive I/O or noncooperative contributions can delay settlement.

Every cell gets a fresh JS environment. `store(key,jsonValue)` and `load(key)`
share only volatile Host JSON state, bounded by Host memory. Normal termination
discards that cell's pending store writes and preserves earlier committed data.
Cancellation racing an already-completed Host result cannot undo its commit.
Script/protocol failure resets the runtime/store. Model change, tree navigation,
session replacement, reload, contribution refresh/disposal and off also reset it.
Five minutes idle or one hour Host lifetime loses it too. Reload never restores
an old ID or replays code; explicit CLI grants may authorize the new session.

```js
const results = await Promise.all(
  ["package.json", "README.md"].map(path => tools.read({path}))
);
store("previews", results.map(result => result.text.slice(0, 200)));
text(load("previews"));
```

Only explicitly emitted `text(value)` reaches model-visible business output.
Image/audio/notification helpers, arbitrary imports, direct filesystem/network
APIs and automatic wrapping of arbitrary Pi tools are unsupported.
Script failures are real Pi error results, retaining partial data/usage.

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

Custom provider streams must opt in on the synchronous
`@oai404iao/pi-code-mode:transport/v1` event: payload `{version:1,accept}`
accepts the **exact registered active `streamSimple` function**, with at most
16 replies. Both legacy and native Provider registrations are checked.
The Codex core shim participates; a provider-name match alone is insufficient.
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
These Codex contributions do not offer S4 direct bindings, so `hide-bridged`
does **not** hide their counterparts or alter existing Codex auto-activation.

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

`effect` is `read|write|process`; only explicitly `parallel:true` reads overlap.
Writes/processes and unspecified parallelism are exclusive FIFO barriers.
The four-worker, sixteen-queued scheduler is **bridge-local**, not a global
lock against direct Pi tools or external processes.

### S4: cooperative direct-tool visibility

`hide-bridged` suppresses only a direct counterpart whose owner explicitly offers
a binding on an **authorized** contribution. A contribution without a binding
stays usable through JS, but cannot hide any Pi tool. In particular, independent
local `tools.read/write/bash` adapters are **not** evidence that Pi's current
read/write/bash implementation is equivalent; those Pi tools remain untouched.
Existing Codex auto-activation is not modified or assumed to cooperate.

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

Pi 0.85.1 has no active-tools-changed event or global visibility lock.
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

`prepare(input)` optionally normalizes arguments, then cloned/frozen final
arguments are schema-checked and supplied to ordered policies and `invoke`.
Invocation context supplies `cellId`, `toolCallId`, cwd, per-invocation signal,
and current Pi context with that signal. Never retain it across invocations.
Adapters must honor abort and await their real effects before resolving.

`registerCodeModePolicy(pi,{id,before?,after?})` returns a disposer.
`before(call)` may return `{block:true,reason?}`; rejection/throw/timeout aborts
before invocation. `after(call,value)` returns redacted JSON before JS sees it.
Hooks run in sorted policy-ID order, with frozen data and a five-second signal
budget. They must cooperate with cancellation; use policy hooks for checks/
redaction, not independent side effects. Discovery caps: 32 providers, 64 tools,
16 policies; schema 8 KiB, description 2000 characters, entire catalog 24 KiB.

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
| Calls / active / queued | 32 / 4 / 16 |
| Bridge result / local write | 64 KiB / 128 KiB |

The IPC ceiling accommodates worst-case JSON escaping of bounded writes; it is
not a larger output allowance. Kernel limits and PID membership are verified
before code/commands run. Unknown stop state retains the OS watchdog and blocks
reuse; killing a proxy is not proof that effects ended.

Verified binaries are copied into private retained runtime directories under
`${XDG_STATE_HOME:-$HOME/.local/state}/pi-code-mode/` (about 46 MB per Host).
Process jobs retain their own directories. Remove only specific inactive
directories manually. No authorization config or transcript is stored there.

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
**not live provider accounts**. See
[`S2 audit`](../../docs/audits/pi-code-mode-s2.md) and
[`S4 audit`](../../docs/audits/pi-code-mode-s4.md), plus the
[`S3 audit`](../../docs/audits/pi-code-mode-s3.md) for actual evidence and remaining
limitations.
