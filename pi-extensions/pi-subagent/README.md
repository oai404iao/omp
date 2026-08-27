# @oai404iao/pi-subagent

Durable, continuable subagents for [Pi](https://github.com/earendil-works/pi-mono).
The design independently adapts the
[DeepSeek Harness subagent seam](https://github.com/deepseek-ai/deepseek-harness/tree/4d03472cd098dc48a630e526ca620f4f37f18a0e/docs/subsystems)
to Pi's extension and SDK APIs.

Compatibility: Pi 0.84.2 or newer; tested against 0.84.2.

> npm identity: `@oai404iao/pi-subagent`. Once the selected version is
> available on npm, install it from npm; use a local checkout before its
> bootstrap or when testing unreleased source.

## Features

- **Named providers**
  - `spawn`: fresh child with no parent conversation
  - `fork`: child seeded through the parent's latest completed turn
- **Readable task paths** such as `/root/review/auth`, with relative addressing
- **Explicit context inheritance**: `fresh`, `all_completed`, or
  `last_n_completed`
- **Two lifecycles**
  - foreground one-shot runs return the child's final answer
  - background continuable runs return a readable path and stable agent id at
    prompt acceptance
- **Foreground-only policy** that removes background scheduling and lifecycle controls
- **Independent context and session** for every child
- **User-owned agent catalog** with bundled templates used only for
  first-install and package-version initialization
- **Durable descriptors and lineage** stored in child JSONL sessions
- **Two background protocols**: compatible immediate follow-ups or an opt-in
  durable mailbox with explicit turn starts
- **Quiet durable completion updates** with event-driven `wait_agent`
- **Control plane** with listing and interruption
- **Child-to-parent `report` channel** for continuable children
- **Nested delegation** with an absolute persisted depth limit
- **Dynamic agent-name enums** generated from the effective user/project catalog
- **Parallel-safe delegation**: multiple `subagent` calls in one assistant message may overlap
- **Bounded background execution** with per-agent cold-resume serialization
- **Optional idle runtime LRU** with transparent cold resume
- **Composable tool ceilings** that preserve model/extension tool decisions
- **Usage accounting, streaming progress, output caps, and custom TUI rendering**

Children run through Pi's SDK in the same Node.js process, but each owns a separate `AgentSession`, context window, session file, tool selection, and extension runtime.

## Install

When the selected version is available on npm:

```bash
pi install npm:@oai404iao/pi-subagent
```

Before its npm bootstrap, or for an unreleased local checkout:

```bash
pi install /absolute/path/to/pi-extensions/pi-subagent
```

Restart Pi or run `/reload`.

For a temporary test:

```bash
pi -e /absolute/path/to/pi-extensions/pi-subagent
```

This implementation targets Pi `0.84.2`.

## Model-facing tools

| Tool | Behavior |
| --- | --- |
| `subagent` | Starts a named child with selectable context inheritance. Background continuable mode is the default unless configured otherwise; foreground-only mode always waits for the answer. |
| `subagent_fork` | Starts a child with all completed parent turns. It remains foreground by default; `run_in_background: true` creates a continuable fork. |
| `send_message` | Targets a direct child by path or durable id. Legacy starts/joins the next FIFO turn; `mailbox-v2` only durably appends. |
| `followup_task` | `mailbox-v2` only: targets a direct child by path or id, atomically claims the pending FIFO batch, and starts one scheduled turn. |
| `wait_agent` | `mailbox-v2` only: waits event-driven for unread direct-child completions without starting a model turn or consuming a scheduler slot. |
| `interrupt_agent` | Requests cancellation of a live descendant by path or id without deleting its session. Active only when background execution is enabled. |
| `list_agents` | Lists readable descendant paths as `running`, `idle`, or `ready`, including separate `pending=N` task and `updates=N` completion counts. Active only when background execution is enabled. |
| `report` | Child-only return channel. Installed automatically in continuable children. |

The `/subagents` command shows the effective scheduling mode, available agent definitions,
and the current descendant catalog.

At session startup, the `agent` parameter on `subagent` and `subagent_fork` is registered
as an enum of the effective catalog. Nested delegation tools receive an activation-scoped
enum. If the effective catalog is empty, both delegation tools are inactive. Run `/reload`
after adding, removing, or renaming an agent definition so the session schema is refreshed.

### Typical prompts

```text
Start scout and reviewer as independent background subagents, then continue inspecting the failing tests.
```

```text
Use subagent_fork with planner to plan the change using our completed discussion.
```

```text
List my subagents, then send the scout a follow-up asking for exact call sites.
```

With `"backgroundProtocol": "mailbox-v2"`, enqueue first and start explicitly:

```text
Send the scout two mailbox messages, then call followup_task once so it handles
the current FIFO batch in one turn. Call wait_agent when the next action needs
its quiet completion update.
```

Pi executes sibling tool calls in parallel, so this package deliberately accepts one delegation per `subagent` call instead of embedding a separate `tasks` array.

### Task paths and context

Every new child has an immutable path rooted at `/root`:

```text
/root
├─ review
│  └─ auth
└─ tests
```

Set `task_name` to choose the final path segment. Names use 1–64 lowercase
ASCII letters, digits, hyphens, or underscores. If omitted, the extension
slugs `description` and appends `-2`, `-3`, and so on to avoid sibling
collisions. Explicit duplicate sibling names fail before child creation.

Control tools retain their existing parameter names for compatibility, but
accept any of:

- a durable UUIDv7 agent id;
- an absolute path such as `/root/review/auth`;
- a path relative to the caller, such as `auth`, `./auth`, or `../tests`.

References cannot escape `/root`. Path lookup is resolved to the durable agent
id before per-agent serialization; mailbox ownership, events, and durable
lineage remain UUID-based. Direct-child restrictions still apply to
`send_message` and `followup_task`, while `interrupt_agent` still requires a
descendant. Paths do not bypass those checks.

`subagent` accepts an optional context object:

```json
{
  "task_name": "review",
  "context": {
    "mode": "last_n_completed",
    "completed_turns": 2
  }
}
```

Context modes are:

| Mode | Initial child context |
| --- | --- |
| `fresh` | No parent conversation. This is the compatible `subagent` default. |
| `all_completed` | The parent's compaction-aware context through its latest completed assistant turn. |
| `last_n_completed` | The last `completed_turns` complete parent turns, bounded to 1–100. |

The active assistant/tool-call suffix is always excluded. A compaction summary
is retained when it is the only safe representation of completed history; if
it prevents exact turn counting, `last_n_completed` keeps that summary only
when fewer than the requested number of explicit completed turns remain.
Context is copied once into a new child session. Descriptor, lineage, mailbox,
completion, and other plain extension-state entries are not copied.

`subagent_fork` is the compatibility shortcut for `all_completed`. It remains
foreground unless `run_in_background: true` is explicitly supplied, even when
`defaultBackground` is true. A background fork is continuable and supports the
same legacy or mailbox-v2 follow-up lifecycle as a fresh child.

New sessions persist descriptor version 3 with their task path and context
policy. Version-2 descriptors remain readable and controllable by UUID; they
are displayed under the deterministic compatibility namespace
`/root/.legacy/<agent-id>`.

## Agent definitions

The package ships `scout`, `planner`, `reviewer`, and `worker` as initialization
templates. On the first extension startup after installation, and whenever the
detected package version changes, those templates are materialized into:

```text
<Pi agent dir>/agents/*.md
```

The package copies are **never runtime agent definitions or fallbacks**.
Runtime discovery reads only:

1. `<Pi agent dir>/agents/*.md`
2. nearest trusted `.pi/agents/*.md`

Project definitions replace user definitions with the same name when project
scope is enabled. Project agents are disabled by the default
`agentScope: "user"`. Setting the scope to `project` selects only project
definitions; `both` loads user definitions followed by project overrides.

After the current package version has been initialized, the user directory is
authoritative. Same-version startups do not restore missing files or refresh
changed templates. If the user deletes every agent definition, the effective
catalog is empty and delegation tools are inactive after restart or `/reload`.
A later package-version change starts a new initialization pass and installs
missing bundled templates again.

Initialization behavior:

1. **First startup:** missing presets are installed. A different pre-existing same-name file
   is backed up before the bundled version replaces it.
2. **Ordinary restart of the same release:** user edits are preserved.
3. **Plugin update:** differing user presets are backed up, then replaced with the new
   bundled versions. A bundled prompt change without a package-version change does not
   trigger a refresh.
4. **Retired preset:** a formerly bundled name is backed up and removed so an obsolete
   prompt does not remain silently active.
5. Files whose names were never managed bundled presets are left untouched.

Synchronization holds a cross-process lock, then preflights and stages the whole update
before changing agent files. If a commit fails, it rolls back already-applied changes and
fails extension startup rather than falling back to package prompts. Same-name symbolic
links are preserved as symbolic links inside the backup directory before the user path is
replaced. An invalid synchronization manifest is copied to a content-addressed
`.corrupt-*` file and skips template initialization; user and project agent discovery
continues with a warning. Repair the manifest, or deliberately remove it to request a new
first-install initialization pass.

Synchronization state and backups live at:

```text
<Pi agent dir>/.pi-subagent/agents-manifest.json
<Pi agent dir>/.pi-subagent/backups/<timestamp>-to-<version>/*.md
```

The startup notification reports installed/updated files and exact backup
paths. To restore a customization after an update, copy its backup over the
corresponding user agent file; later startups of that same plugin release
preserve the restored edit.

Add or edit user agents as Markdown files with YAML frontmatter:

```markdown
---
name: security-reviewer
description: Review authentication and authorization changes
tools: read, grep, find, ls, bash
model: openai/gpt-5.4
thinking: high
---

Review the delegated change. Report concrete security defects with exact paths.
```

Frontmatter:

| Key | Required | Meaning |
| --- | --- | --- |
| `name` | yes | Stable tool-visible name. |
| `description` | yes | Short catalog description. |
| `tools` | no | Comma-separated hard ceiling; use `none` for no ordinary tools, `$mutation` for the active mutation implementation, or omit to preserve the child runtime's active tools. |
| `model` | no | `provider/model` or an unambiguous model id; omitted means inherit the parent model. |
| `thinking` | no | `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`. |

For continuable children, `report` is retained even when the agent has a tool allowlist.

### Tool policy and inherited extensions

An explicit `tools` list is a **maximum permission ceiling**, not an instruction to
blindly activate every registered tool:

1. Pi builds the child registry from only the listed tools and runtime-mandatory controls.
2. Inherited extensions run their `session_start` handlers and select tools for the child model.
3. The agent allowlist narrows that active set. A registered but extension-disabled explicit
   tool fails loud instead of being re-enabled.

The foreground-only runtime policy is applied after this composition and removes background
lifecycle controls even when an agent definition names them.

The reserved logical tool `$mutation` lets one definition work with both standard Pi and
model-specific tool extensions:

- if an inherited extension leaves `apply_patch` active, `$mutation` resolves to `apply_patch`;
- otherwise it resolves to the active built-in `edit` and/or `write` tools;
- if no mutation implementation is active, child creation fails before the first model request.

The bundled `worker` uses `$mutation`. For example, to use
`@oai404iao/pi-codex-minimal-tools` inside workers:

```json
{
  "inheritExtensions": true
}
```

The Codex extension may then select `apply_patch` and suppress `edit`/`write`; the
subagent ceiling preserves that decision. Tools injected by other extensions but not named
by the agent remain unavailable. Unknown logical names beginning with `$` are rejected.

Omitting `tools` intentionally opts out of a hard ceiling and preserves the effective tool
set chosen by Pi and inherited extensions. This is more permissive than an explicit list.

## Configuration

Configuration is loaded from:

1. `<Pi agent dir>/subagent.json`
2. nearest trusted `.pi/subagent.json` (project overrides)

See [`config.example.json`](config.example.json) and [`config.schema.json`](config.schema.json).

```json
{
  "$schema": "/path/to/pi-subagent/config.schema.json",
  "agentScope": "user",
  "maxDepth": 3,
  "enableRunInBackground": true,
  "defaultBackground": true,
  "maxConcurrentBackgroundRuns": 4,
  "maxIdleRuntimes": 0,
  "backgroundProtocol": "legacy",
  "reportDelivery": "wakeup",
  "inheritExtensions": false,
  "openAIIdentity": false,
  "maxOutputBytes": 51200
}
```

| Setting | Default | Meaning |
| --- | --- | --- |
| `agentScope` | `user` | Select user definitions, project definitions, or user definitions followed by project overrides. |
| `maxDepth` | `3` | Absolute delegation depth; a top-level Pi session is depth 0. |
| `enableRunInBackground` | `true` | Enable continuable background children and their model-facing lifecycle controls. Set `false` for strict foreground-only mode. |
| `defaultBackground` | `true` | Default scheduling for `subagent` calls when background execution is enabled. `subagent_fork` remains foreground unless explicitly requested. |
| `maxConcurrentBackgroundRuns` | `4` | Maximum continuable subagent turns executing at once in one extension runtime. Additional top-level runs wait in FIFO order; nested work fails at capacity instead of deadlocking its parent turn. |
| `maxIdleRuntimes` | `0` | Process-wide LRU capacity for settled continuable runtimes. `0` preserves immediate unload; a positive value keeps the most recently used idle runtimes and transparently cold-resumes evicted paths. |
| `backgroundProtocol` | `legacy` | `legacy` preserves immediate `send_message` turns. `mailbox-v2` makes `send_message` enqueue-only and requires `followup_task` to start a turn. The protocol is snapshotted in each child descriptor. |
| `reportDelivery` | `wakeup` | Controls explicit `report` calls: `wakeup` starts/queues a parent turn; `quiet` waits for the parent's next turn. Mailbox-v2 completion updates are always quiet. |
| `inheritExtensions` | `false` | Load other Pi extensions in child runtimes. This package filters itself out; explicit agent tool ceilings still apply. |
| `openAIIdentity` | `false` | For OpenAI Responses child models, inject only the named `pi-codex-minimal-tools` identity lifecycle inline. Codex Session/Thread/Turn/Window ids remain owned and serialized by that package. |
| `maxOutputBytes` | `51200` | Cap for parent-visible foreground output, reports, completion updates, and legacy settlement notices. Full output remains in the child session. |

Invalid configuration and unknown child tool names fail loud before the child's first model request.

The retired user-level `syncBundledAgents` key from versions 0.2 and 0.3 is
accepted for configuration compatibility but ignored. Template initialization
is now automatic and runtime discovery never reads bundled definitions.

`openAIIdentity` and `inheritExtensions` are independent. The former adds only
the lightweight Codex identity lifecycle even when normal extension inheritance
is disabled. Enable `inheritExtensions` as well when the child should receive
the complete separately installed Codex extension tool surface such as
`web_search` and `apply_patch`.

The Codex adapter is an optional package dependency. If an installation omits
optional dependencies, `openAIIdentity: true` fails before the child starts
with an actionable missing-adapter error.

### Foreground-only mode

```json
{
  "enableRunInBackground": false
}
```

In this mode:

- `subagent` always waits for the child's final answer, even when `defaultBackground` is `true`;
- `run_in_background` is removed from the model-facing schema at session startup;
- a forced `run_in_background: true` call is rejected before a child is created;
- nested subagents inherit the foreground-only policy through the durable runtime snapshot;
- `send_message`, `followup_task`, `wait_agent`, `interrupt_agent`, and `list_agents` are removed from the active
  model tool set, including inside nested children;
- sibling foreground calls may still execute in parallel in one assistant message.

`subagent_fork` remains foreground in this mode and its `run_in_background`
field is removed too. The `/subagents` command remains available for human
inspection of historical children, but persisted continuable children cannot
be resumed until background execution is re-enabled. Run `/reload` or restart
Pi after changing this setting so the active tool set and displayed schema are
refreshed.

## Lifecycle

```text
parent AgentSession
  └─ subagent tool
      └─ provider (spawn | fork)
          └─ child Session + pi-subagent/descriptor
              └─ optional live Activation (AgentSessionRuntime)
                  ├─ one or more FIFO turns
                  └─ owned continuable descendants
```

### One-shot

The caller waits for one isolated child run. Only the child's last non-empty assistant output enters the parent tool result. The runtime is disposed on every path; the child session remains available as a trace when persistence is enabled.

### Continuable

The start tool resolves at prompt preflight acceptance and returns the child's
readable task path plus stable agent id (UUIDv7). Agent ids are independent of
Pi session (file) ids: they are
generated once per subagent, recorded in the child's session as `pi-subagent/agent`,
and chained through `parentAgentId` in the descriptor, so children stay addressable
even when a parent session is forked or re-created. When an activation settles:

1. `legacy` sends the parent its existing wakeup settlement; `mailbox-v2`
   appends a quiet completion update to the direct parent's session instead;
2. once owned descendants are done, the child runtime is either disposed or
   retained in the optional idle LRU;
3. an unloaded persistent session is `ready`; a retained settled runtime is
   `idle`;
4. legacy `send_message`, or mailbox-v2 `followup_task`, can cold-resume that
   same session for another turn.

A child can explicitly call `report` before settlement. Reports retain
`reportDelivery` behavior and are separate from quiet mailbox-v2 completions.

Continuable turns share a bounded scheduler. Calls targeting the same durable
agent are serialized so concurrent messages cannot create multiple cold
runtimes for one child session. Every scheduler-admitted run has a stable
`turnId` in delegation details and the paired `pi-subagent:turn-start` /
`pi-subagent:turn-end` events. FIFO follow-ups accepted while that
`AgentSession` is already running remain part of the same admitted run.
Existing `pi-subagent:start` / `pi-subagent:end` events continue to describe
the wider activation lifecycle and now include `taskPath`.

With `maxIdleRuntimes: 0`, disposal behavior is unchanged. A positive value
retains only settled continuable runtimes with no active run, owned descendant,
or pending mailbox claim. LRU accounting is serialized across concurrent
settlements. Eviction disposes only the runtime; the descriptor, path, context,
session history, task mailbox, and completion mailbox remain durable, so the
next accepted turn cold-resumes normally.

#### Mailbox-v2

Set `"backgroundProtocol": "mailbox-v2"` to separate delivery from execution:

1. `send_message` appends a bounded message record to the direct child's JSONL
   session and returns its stable message id. It does not create a runtime,
   acquire a scheduler permit, create a `turnId`, or emit turn events.
2. `followup_task` snapshots the current pending FIFO prefix, waits for the
   normal background scheduler, and starts one turn containing that batch.
   Messages arriving after the snapshot remain pending for a later turn.
3. A claim is committed only after Pi prompt preflight succeeds. The durable
   user-turn marker makes a claim without its corresponding prompt recoverable
   after a crash. Once the user turn is durable, the batch is consumed even if
   that model turn later fails or is interrupted.
4. Scheduler rejection, cancellation while queued, and shutdown before prompt
   acceptance leave the batch pending. Concurrent sends and starts for one
   agent are serialized within the extension process.
5. A completed turn appends a stable completion record to the direct parent's
   separate notification mailbox before the child unloads. This custom entry
   does not enter model context and does not wake or start the parent.
6. `wait_agent` returns existing unread updates immediately or subscribes to
   in-process mailbox activity and rechecks durable state after wakeup. Its
   optional timeout defaults to 30 seconds and is capped at 120 seconds.
7. A returned update becomes read only after Pi durably appends the successful
   `wait_agent` tool result. An interrupted/failed delivery is released at the
   end of the parent turn; a process restart also makes an orphan reservation
   available again. Delivery output is bounded to a 256 KiB FIFO prefix.
8. If the parent completion append fails, the child records an undelivered
   fallback in its own session and emits `pi-subagent:completion-error` before
   normal residency cleanup; no false completion is exposed to `wait_agent`.

Each message is limited to 131,072 characters; a mailbox is limited to 256 pending
messages and 256 KiB of pending UTF-8 content. `list_agents` exposes task
`pending` and completion `updates` independently from lifecycle and scheduler
state.

`mailbox-v2` is opt-in. Existing descriptors without a protocol field resume as
`legacy`, and the default legacy tool behavior is unchanged. A persisted
mailbox-v2 child keeps its protocol snapshot. `followup_task` and `wait_agent` remain available
when such a child exists even if the current default is later changed back to
legacy.

`wait_agent` observes only completions written by the current agent's direct
children. Nested parents consume their own child updates; a root wait does not
steal grandchild updates. Legacy settlements and all explicit reports retain
their previous behavior.

### Inherited-context boundary

The parent is executing a tool when an inherited-context child starts, so its
current assistant/tool-result sequence is incomplete. The provider projects
Pi's active compaction-aware context only through a safe completed boundary,
then copies model-facing entries into a new child session. This avoids seeding
an invalid unbalanced tool turn and prevents parent control-log records from
becoming child descriptors or mailbox ownership.

## Security

- Extensions and subagents run with the user's OS permissions.
- First-install and package-version initialization writes bundled templates
  into the user agent directory and may create backups under
  `<Pi agent dir>/.pi-subagent/backups`.
- Project-local agents are repository-controlled prompts. They are loaded only when the project is trusted and configuration enables project scope.
- `inheritExtensions` is disabled by default because loading an extension in a child executes its code and may duplicate external side effects.
- Explicit agent tool lists are enforced as registry ceilings, but this controls model visibility and execution composition rather than providing an OS sandbox.
- A child may send content only to its recorded direct parent through `report`;
  path resolution is only an address lookup, and `send_message` /
  `followup_task` still require direct-parent identity.

## Current limitations

- Activations, scheduling ownership, and mailbox serialization are process-local;
  two Pi processes must not concurrently control the same child session.
- Readable-path reservation and idle-LRU accounting are process-local. Durable
  UUID identity remains authoritative when multiple processes are involved,
  which is still unsupported.
- Resident parents still retain `ownedChildren` until descendants settle;
  actor-graph residency, orphan handling, and background GC are not implemented.
- Pi lazily creates a new child JSONL file on its first assistant entry. The
  initial background agent id therefore has a crash window after prompt
  acceptance; mailbox-v2 `send_message` waits for that first durable checkpoint
  before acknowledging an enqueue.
- Legacy `send_message` still has Pi's prompt-acceptance crash window. Use
  `mailbox-v2` when delivery must be persisted before an explicit turn start.
- `interrupt_agent` is fire-and-return and relies on Pi's current `AgentSession.abort()` queue behavior.
- Structured-output delegation is not implemented yet.
- Continuable starts require a persisted parent session; ephemeral (`--no-session`) parents can use foreground one-shot delegation only.
- `subagent_fork` needs a persisted parent to copy completed history; before the first completed turn its safe prefix is empty and it behaves like a fresh child.
- The extension currently uses Pi's `ModelRegistry` compatibility facade to recover the active `ModelRuntime`; this is why the package pins its tested Pi generation.

## Development

```bash
npm install
npm run check
```

The test suite includes provider-boundary, descriptor, configuration, discovery, extension-load, foreground-run, background-settlement, and cold-resume coverage with a scripted local model.

## License and publication status

MIT © 2026 oai404iao. See [LICENSE](LICENSE) and
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

Bundled presets are initialization templates only. Runtime agent discovery is
limited to user and trusted project configuration.
