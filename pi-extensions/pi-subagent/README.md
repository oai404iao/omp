# @oai404iao/pi-subagent

Asynchronous, reusable agent trees for [Pi](https://github.com/earendil-works/pi).
The runtime independently adapts **Codex multi-agent v2**, with ordinary
plaintext JSON tools rather than encrypted arguments.

Tested Pi floor and development target: **1.2.0**.

## Install

```bash
pi install npm:@oai404iao/pi-subagent
# To run this checkout before its next release:
pi install /absolute/path/to/omp/pi-extensions/pi-subagent
```

Restart Pi or `/reload`. No presets or configuration files are automatically
written. A configured agent catalog is optional: without one, `spawn_agent`
uses the default child policy and inherits the caller's model/reasoning level.

## Seven model-facing tools

Root and children use the same definitions. All are `model-only`, not callable
through codemode or nested tool execution. Schemas, descriptions and output
schemas live in [`src/schemas.ts`](src/schemas.ts); handlers are shared in
[`src/tools.ts`](src/tools.ts).

| Tool | Input | Behavior / result |
| --- | --- | --- |
| `spawn_agent` | `task_name`, `message`; optional `fork_turns`, `agent_type`, `model`, `thinking` | Starts a child asynchronously; returns `{task_name:"/root/name",model,thinking}` after task acceptance, not completion. |
| `send_message` | `target`, `message` | Queues plaintext communication; returns `{accepted:true}`. Does not start an idle agent. |
| `followup_task` | `target`, `message`; optional `model`, `thinking` | Gives an existing non-root agent more work; starts an idle target or delivers at a running target's safe boundary. Returns `{accepted:true,model,thinking}`, not an answer. |
| `wait_agent` | optional `timeout_ms` | Waits for the caller's mailbox activity or steered user input. Returns `{message,timed_out}`, never message bodies. |
| `interrupt_agent` | `target` | Requests cancellation of the current run; returns `{previous_status}`. No deletion or recursive interruption. Root and self cannot be interrupted. |
| `close_agent` | `target` | Permanently closes the target **and its entire structural subtree**. Only structural ancestors may close; never root, self or siblings. Returns `{accepted:true,target,lifecycle,affected_count}`, not a guarantee that cancellation has finished. |
| `list_agents` | optional `path_prefix`, `include_closed`, `limit`, `cursor` | Lists `{agents:[{agent_name,agent_status,lifecycle,model,thinking,last_response?}],next_cursor?}` in this root tree without resuming agents. Closed records are hidden by default. |

Example sequence:

```json
{"task_name":"review","message":"Review authentication; report concrete defects.","fork_turns":"all"}
```

Continue independent work. Send context without requesting another idle turn:

```json
{"target":"review","message":"The changed files are src/auth.ts and tests/auth.test.ts."}
```

Give the same agent another task:

```json
{"target":"review","message":"Now verify the fix against the regression tests."}
```

The last call is `followup_task`, **not** another `send_message`. It already
contains the task; there is no enqueue-then-start protocol.

### Execution selections

`model` uses the existing resolver; prefer full `provider/model-id`. Unqualified
IDs retain compatibility matching, but unknown or ambiguous selections fail.
`thinking` accepts exactly `off`, `minimal`, `low`, `medium`, `high`, `xhigh`,
`max`; there is no `reasoning_effort` alias.

Each spawn field resolves independently: explicit call value, then configured
role value, then the caller's current selection. Follow-up fields resolve from
explicit values, then the **target's saved selection**. Accepted overrides are
sticky across later tasks and cold resume; role defaults and the follow-up
initiator's model do not replace them. Role, system prompt, tool ceiling and
history remain unchanged. Selection changes use Pi's session records, not a
new conversation or global model defaults.

A running target accepts omitted or effectively identical configuration at its
normal safe boundary. A different configuration fails with
`PROFILE_CHANGE_REQUIRES_IDLE` before enqueueing the task or changing selection.
Wait for idle and explicitly submit again; there is no hot switching, implicit
interruption or deferred configuration queue.

Before accepting a selection, registration, Pi model availability and configured
credentials are checked. Explicit unsupported thinking fails instead of silently
clamping; inherited and role levels use Pi normalization, and acceptance reports
the effective value. This local preflight does **not** prove endpoint access or
account entitlement. Runtime errors remain normal recorded failures.
Task and selection admission share one atomic control snapshot. A selection-record
write failure before task receipt rolls back that admission without removing
independently accepted mail or closure audit. Partial append-only Pi selection
records remain traces; the saved control selection repairs them on the next
explicit run, without rebuilding history.

All `model`/`thinking` results are the **selected pair**, including virtual model
selections. Optional `last_response:{model,thinking?}` reports the latest successful
physical response from Pi records, not the next route. It is omitted without
such a response; absent actual thinking is not inferred. Every child run also
receives authoritative runtime context with its canonical path, structural
parent path and selected pair.

### Closing and listing

Lifecycle (`open` → `closing` → `closed`) is independent of execution status.
Closing publishes a durable subtree-wide barrier before requesting interruption:
new user messages, follow-ups, children and execution starts are blocked. It
becomes closed only after execution exits and runtimes dispose. Repeated closing
is idempotent; names and identities remain reserved and cannot be reactivated.
`interrupt_agent` still affects only one current run, and automatic unloading
still leaves an open identity reusable.

Transcripts, unread mail, canceled tasks, closure actor/timestamps and completion
outboxes remain available for audit. Internal completions addressed to a closed
structural parent remain there (or in a durable outbox under mailbox pressure);
they neither wake it nor redirect to root. Closure cannot undo tool side effects
and is **not disk cleanup**. There is no TTL, automatic closing/deletion, history
GC or open/total-agent quota; `maxConcurrentAgents` still bounds active runs.

Lists default to 50 entries (`limit:1..200`) in stable path order. Use
`include_closed:true` for closed records and pass `next_cursor` back as `cursor`
with the same filters. Invalid/cross-tree cursors fail. Pagination does not
freeze a live tree, start or recover runtimes, or insert root again on every page.
Canonical branch filtering and `path_prefix` still apply, including to closed
records: branch visibility is not lifecycle openness.

### Paths and history

- Root is `/root`. Names contain 1–64 lowercase ASCII letters, digits or
  underscores; `root` is reserved. Names remain reserved for the tree's lifetime.
- Relative references resolve below the caller. `/root/a` can address its child
  as `child`; communication with `/root/b` uses that canonical path.
- No UUID addressing, `../`, `./`, trailing slash, or hyphenated task names.
- `fork_turns` is `"all"` by default, or `"none"` for a fresh conversation.
- `"all"` copies the canonical, compaction-aware projection through completed
  turns only. The active assistant/tool suffix, parent system authority and
  extension control records are not inherited.
- Children can communicate with their parent and siblings within the same tree.
  `followup_task` can target a non-root peer; completion still goes to the
  **structural parent**, not necessarily the task initiator.

### Message delivery and waiting

Running agents receive attributed messages at safe conversation boundaries,
after pending tool results. Messages arriving after a closing boundary stay
pending; new tasks schedule another run. Plain messages and completion
notifications do not start idle agents.

`wait_agent` waits for **activity in its own inbox**, not a selected child's
terminal status. It does not consume messages. Bodies enter the conversation as
separate attributed custom messages; durable context receipts acknowledge them.
The default timeout is 120 seconds; values below 10 seconds are raised to 10
seconds; values above 1 hour are rejected. User input and cancellation can end
the wait earlier. There is no persistent sleep/background wakeup service.

Wait only when no independent work remains. Implementation, review, and test
runs may take several minutes; use `timeout_ms:300000` for longer tasks rather
than repeatedly polling every 10–30 seconds. The timeout is an upper bound, not
a task deadline: mailbox activity or steered user input returns immediately.
A wait timeout neither cancels agents nor indicates task failure, and is not
by itself a reason to restart or interrupt a child.

Final success/error output is automatically queued to the direct parent.
Interruption does not emit a successful completion. An idle parent stays idle;
its messages enter its next turn. A full parent mailbox retains the result in a
durable child outbox until delivery has room.

Messages are limited to 131,072 characters. Each inbox holds at most 256 pending
messages and 256 KiB of message text. Completion output is bounded by
`maxOutputBytes` and a 128 KiB delivery cap, with a full-session path on
truncation. These limits do not truncate the child's stored transcript.

## Runtime and persistence

One root-scoped controller owns identities, paths, mailboxes and execution
admission. Each active child owns an SDK `AgentSessionRuntime`. An idle runtime
is unloaded; its identity, history and inbox remain reusable by cold resume.
Parent residency is not required for descendants to finish.

Each child has an independent model runtime and provider/virtual-model
registration tables. Initialization and reload snapshot the root's resolved
catalogs, provider definitions, virtual routes and runtime API keys; stored
credentials remain shared. Inherited extensions then register fresh child-local
providers. Child registration, unregistration and runtime-key overrides cannot
replace a parent's or sibling's callbacks, including after child disposal.

Root callbacks and virtual routes remain root-bound; this does not rebind opaque
extension closures. Descendants always start from the root baseline, not a
temporary intermediate agent's registrations. Child-only models/routes must be
recreated by inherited extensions; a missing selected model fails explicitly.
Remote/personalized root catalogs are snapshots, not shared mutable refresh
wrappers. Pi 1.2's private runtime-constructor adaptation is isolated and checked
in `src/model-runtime.ts`; incompatible SDK layouts fail rather than sharing a
mutable runtime again.

Statuses are `pending_init`, `running`, `completed`, `interrupted`, `errored`.
They describe execution, not whether a runtime currently occupies memory.

Concurrency counts active child runs across the **whole tree**, not separately
at each level. Root does not count. Admission fails immediately at capacity;
it does not silently queue behind a parent that may be waiting on its child.
Mailbox operations and waits do not acquire extra slots; a waiting child still
holds its own active-run slot.

Control state and transcripts live alongside Pi session storage:

```text
<sessionDir>/<rootPiSessionId>.subagents/<treeId>/
├─ state.json
└─ sessions/*.jsonl
```

The dashboard keeps best-effort run timing and context snapshots in adjacent
`sessions/*.jsonl.telemetry.json` files. This metadata is independent of
transcript ancestry and control-state commits; missing or damaged telemetry
does not prevent agent execution or recovery.

The control snapshot is atomically replaced and synced before acknowledging
messages. Child JSONL setup is materialized before publishing the child, without
inventing a user/assistant turn. Transcript receipts are checked on disk before
mailbox ACKs. Failed snapshot writes do not advance in-memory state.

On restart, unfinished runs become interrupted and **are not automatically
replayed**. Explicit follow-up reuses the agent's conversation and pending
messages. This does not provide exactly-once external tool side effects.
Failed storage writes can leave `.pending` recovery artifacts; no automatic
cleanup deletes user traces.

Registration is tied to the parent's canonical branch. Abandoned-branch agents
cannot be addressed or silently resumed. Forking a root Pi session creates an
independent tree. Session switch, `/tree`, shutdown and reload drain the old
controller before replacing it. No cross-process coordination is provided:
never control the same tree from multiple Pi processes.

Both `/fork` and `/clone` create a new root session ID and independent tree
containing only `/root`; copied history does not copy agent identities, mailboxes,
runs or pending tasks. Pi 1.2.0 implements `/clone` through
`fork(leafId,{position:"at"})`, not a clone-specific event. Copied tree markers
and `parentSession` do not grant old-tree control. Before a new tree runs,
authoritative English context explains that old paths belong to the old tree and
delegation must spawn new agents. It is identity/header-based, not dependent on
the session event reason, and does not rewrite or repeatedly append copied history.
An independent process branching history does not stop the original process.

Switching sessions interrupts and drains, but does not permanently close old
identities. Resuming restores open identities without replaying unfinished work.
`/tree` navigation similarly drains and honors canonical registration anchors;
returning to a branch does not execute pending work. Closure is tree-level durable
control state and is not undone by returning to earlier messages.

Persistent parent sessions are required for delegation; there is no
`--no-session` foreground fallback.

## Agent definitions and permissions

Optional user definitions: `<Pi agent dir>/agents/*.md`.
Project definitions: nearest trusted `.pi/agents/*.md`.
`agentScope` selects user, project, or both with project name overrides.
Discovery is read-only. `/reload` refreshes the catalog and stops existing work.

```markdown
---
name: reviewer
description: Review authentication changes
tools: read, grep, find, ls
model: openai/gpt-5.4
thinking: high
---

Report concrete defects and exact file locations.
```

`name` and `description` are required. Optional fields:

- `model`: `provider/model`, or an unambiguous model ID.
- `thinking`: a Pi thinking level.
- `tools`: comma-separated ordinary-tool ceiling; `none` grants no ordinary
  tools; `$mutation` chooses active `apply_patch`, otherwise active `edit/write`.
  Omit to use the default child policy, narrowed by any inherited parent ceiling.
  Names are exact: CLI patterns and `+name`/`-name` modifiers are not supported.
  The whole-field `all` or `*` retains the omitted-list behavior.

The seven collaboration controls are runtime tools retained independently of
ordinary-tool allowlists; the depth/concurrency checks always apply. Nested
roles cannot widen a parent's ordinary-tool ceiling. Explicit tool names must
exist and respect extension activation choices. Callable-only codemode/deferred
tools are not eagerly declared; discoveries on a child's branch survive resume.
An explicit ceiling excludes unnamed MCP tools, including tools registered late;
Pi's CLI exception that preserves MCP outside an allowlist does not apply here.
Exact MCP names must already be registered during child initialization. MCP
resource tools (`list_mcp_resources`, `list_mcp_resource_templates`,
`read_mcp_resource`) require their own exact grants; naming an MCP tool does not
grant resource access. An omitted ceiling retains the default registry policy.

Extensions are not inherited by default. If enabled, project trust is propagated
to child resource discovery. Pi-subagent itself is filtered out, and built-in
codemode/tool-search respect Pi settings and registry ceilings. Codemode model
calls are disabled in children. Built-in MCP is not automatically injected.

Children share the process, working directory and filesystem; they are **not OS
sandboxes or isolated Git worktrees**. Tool ceilings are not filesystem security.

## Configuration

Read from `<Pi agent dir>/subagent.json`, followed by the nearest trusted
`.pi/subagent.json`. Unknown keys and invalid values fail explicitly.

```json
{
  "agentScope": "user",
  "maxDepth": 3,
  "maxConcurrentAgents": 4,
  "inheritExtensions": false,
  "openAIIdentity": false,
  "maxOutputBytes": 51200
}
```

See [`config.schema.json`](config.schema.json) and
[`config.example.json`](config.example.json).
`maxDepth:0` disables spawning without removing communication tools.
`openAIIdentity` independently adds the optional Codex identity lifecycle for
OpenAI Responses/virtual models; it does not install Codex tools or change
provider authentication. When identity is required, a missing optional adapter
fails before model execution. When the Codex adapter is installed, children also
follow the main session's Fast mode for subsequent requests, independently of
`openAIIdentity` and `inheritExtensions`, including through non-Responses parents.
### Subagent dashboard

`/subagents` opens a live, read-only dashboard in Pi's terminal UI. It follows
the current root session and canonical branch, including completed agents whose
runtimes have unloaded. Other sessions and abandoned-branch agents are excluded.
Opening or closing the dashboard does not start, interrupt or resume agents.
`/subagents catalog` retains the agent-definition catalog and text tree.
Outside terminal UI mode, `/subagents` retains the text summary.

The left pane lists agent paths, types, current tasks, status, estimated cost,
run time, request/tool counts, tokens and creation time. Select an agent to see
its information, usage and recent activity on the right. Narrow terminals use
a list/detail layout instead of squeezing both panes together.

- `↑`/`↓` or `j`/`k`: select an agent.
- `Tab`: switch panes; `PgUp`/`PgDn`: scroll the focused pane.
- `Enter`: open details in the narrow layout; `Esc`: return, then close.
- With details focused, `Enter` expands or collapses the task preview.
- `t`: open the selected agent's read-only transcript; `Esc` returns to the
  dashboard without changing its selection or scroll position.
- `f`: switch the read-only Open (including closing) / Closed lifecycle filter.
  Closed histories remain inspectable; there are no management or delete buttons.
- Fullscreen mode also supports mouse selection and scrolling.

Lifecycle is shown separately from execution status. Details label the selected
model/thinking separately from the last successful physical response; virtual
model dispatch is historical information, not a prediction of the next request.

Recent activity shows bounded, multiline previews of commands, edits, writes,
patches, ordinary responses and tool output, including streamed updates.
Previews are local transcript content: terminal control sequences are removed,
but secrets inside commands, file contents or output are not automatically
redacted. Thinking text and opaque replay payloads are not shown.
The agent list shows creation time as `HH:mm:ss`, without a relative age.
Its execution durations are sampled when the dashboard opens (or when a new
agent first appears) and remain fixed until reopening. Status and usage metrics
still refresh; the details pane retains its live execution duration.
Context snapshot timestamps are not displayed.

The transcript uses Pi's native message components and tool renderers inside
the existing dashboard, not another interactive session. Messages retain their
structured roles and content; there are no extra plugin-generated message
headings. Built-in tools use their public Pi renderer definitions rather than
plugin-specific command, code or diff formatting. It follows live output until you
scroll away. `End` returns to the latest page and resumes following; `p` loads
the previous history page. `↑`/`↓` or `j`/`k` scroll, and `PgUp`/`PgDn` scroll
by a page. Pi's configured tool-output expansion shortcut expands or collapses
tool output; fullscreen mouse clicks can toggle individual tools.

History comes from the child's canonical JSONL branch, including its work
before compaction. Copied parent history is counted but not mixed into the
child's work. Large content, pages and the live display cache are bounded and
identified when truncated. Images and thinking are omitted from this view.
Recorded edit diffs are displayed without reading today's file to reconstruct
an old edit. Patch previews that would inspect today's files are disabled.
While a child runtime is resident, custom tools and messages use its registered
renderer/resolver chain and Markdown transformers. Unloaded or restarted agents
use native built-in rendering and Pi's generic fallback for unavailable custom
renderers; viewing does not reload extensions or reconnect providers to recover
them. Source details such as output truncation, full-output paths and recorded
tool durations are preserved for the native renderers.
Pi does not persist nested tool output: it can be visible while the runtime is
active, but after unloading or restarting only recorded nested-call metadata
is available. Viewing never executes tools to recover missing information.
Opening, closing or paging the transcript does not prompt, interrupt or retain
a child runtime, change the main session, or write/repair session files.

Statistics are **agent-owned**, excluding copied parent history. The summary
sums visible child agents once, not the root's mirrored subagent usage.
Token/cost totals include recorded tool model usage, compaction and auxiliary
usage. `req` counts finalized Pi assistant responses, not HTTP attempts; nested
tool executions are reported separately from top-level tool calls. Reasoning
tokens, when available, are a subset of output tokens.

Cost is an estimate from recorded usage, not a bill. Missing pricing or data is
shown as unavailable rather than free. Context is Pi's estimated current usage,
including inherited history; it is separate from cumulative token consumption.
An unloaded agent shows its last context snapshot. After compaction, context
can remain unknown until the next model response.

Run time sums execution intervals, including tools and in-run waits but excluding
idle time between tasks. New runs retain separate timing/context metadata;
older or crash-interrupted runs can have incomplete timing. Unknown values and
partial history are identified explicitly; opening the dashboard never replays
work to recover statistics. Recent activity retains at most 50 summaries;
content previews are limited to 240 Unicode characters and a few display
lines. Use the transcript for more detail rather than treating these previews
as complete tool arguments or results.

## Breaking migration

- Replace `subagent` and `subagent_fork` with `spawn_agent`.
- Replace `prompt` with `message`; choose a required `task_name`.
- Replace `agent` with optional `agent_type`.
- Replace context mode objects with `fork_turns:"all"|"none"`; default is now all.
- Replace `subagent_id` / `agent_id` with `target` paths.
- Add `message` to `followup_task`; it no longer claims a pre-enqueued batch.
- Replace child `report` with `send_message` targeting its parent.
- Do not parse completion text from `wait_agent`; read the attributed context.
- Remove `runtimeMode`, `maxIdleRuntimes` and all earlier retired switches.
- Rename `maxConcurrentBackgroundRuns` to `maxConcurrentAgents`.
- Update agent `tools` lists that name removed tools.

Descriptor v4 and earlier are not migrated or resumed. Old transcripts,
configuration and preset files are left untouched. Current descriptors are v5;
the new tree-store format is independently versioned. Package versioning is
handled through Changesets, not by labeling this protocol “package version 2”.
Tree-store v1 and descriptor v5 remain supported. Missing lifecycle in earlier
v1 records explicitly means `open`; new optional closure/response audit fields
may be absent. A recovered `closing` subtree is completed as closed only with
no resident execution; unfinished runs remain interrupted, never replayed.
No unsupported descriptor is silently migrated, and old traces are not deleted.

## Upstream reference and development

Codex tracking baseline: `551bd409ebf03fc6ea0dcad0915368d8a493f012`
(remote main verified October 6, 2026). See
[`provenance/openai-codex-551bd409-multi-agent-v2.json`](provenance/openai-codex-551bd409-multi-agent-v2.json)
and [third-party notices](THIRD_PARTY_NOTICES.md).
Intentional Pi differences include plaintext arguments, optional Markdown roles,
completed-turn-only history copying, persistent receipts, all-registered-agent
listing, and no Codex durable sleep or provider-specific tool namespace.

```bash
# Repository root; use the canonical root lockfile.
pnpm --filter @oai404iao/pi-subagent run check
pnpm run ci
pnpm run ci:pi-matrix
```

Tests use scripted local models and actual Pi SDK runtimes, not live credentials.
MIT © 2026 oai404iao; upstream reference licenses/notices are retained separately.
