# @oai404iao/pi-subagent

Asynchronous, reusable agent trees for [Pi](https://github.com/earendil-works/pi).
The runtime independently adapts **Codex multi-agent v2**, with ordinary
plaintext JSON tools rather than encrypted arguments.

Tested Pi floor and development target: **0.99.1**.

## Install

```bash
pi install npm:@oai404iao/pi-subagent
# To run this checkout before its next release:
pi install /absolute/path/to/omp/pi-extensions/pi-subagent
```

Restart Pi or `/reload`. No presets or configuration files are automatically
written. A configured agent catalog is optional: without one, `spawn_agent`
uses the default child policy and inherits the caller's model/reasoning level.

## Six model-facing tools

Root and children use the same definitions. All are `model-only`, not callable
through codemode or nested tool execution. Schemas, descriptions and output
schemas live in [`src/schemas.ts`](src/schemas.ts); handlers are shared in
[`src/tools.ts`](src/tools.ts).

| Tool | Input | Behavior / result |
| --- | --- | --- |
| `spawn_agent` | `task_name`, `message`; optional `fork_turns`, `agent_type` | Starts a child asynchronously; returns `{task_name:"/root/name"}` after task acceptance, not completion. |
| `send_message` | `target`, `message` | Queues plaintext communication; returns `{accepted:true}`. Does not start an idle agent. |
| `followup_task` | `target`, `message` | Gives an existing non-root agent more work; starts an idle target or delivers at a running target's safe boundary. Returns acceptance, not an answer. |
| `wait_agent` | optional `timeout_ms` | Waits for the caller's mailbox activity or steered user input. Returns `{message,timed_out}`, never message bodies. |
| `interrupt_agent` | `target` | Requests cancellation of the current run; returns `{previous_status}`. No deletion or recursive interruption. Root and self cannot be interrupted. |
| `list_agents` | optional `path_prefix` | Lists `{agents:[{agent_name,agent_status}]}` in this root tree, including unloaded reusable agents. Does not resume them. |

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

The six collaboration controls are runtime tools retained independently of
ordinary-tool allowlists; the depth/concurrency checks always apply. Nested
roles cannot widen a parent's ordinary-tool ceiling. Explicit tool names must
exist and respect extension activation choices. Callable-only codemode/deferred
tools are not eagerly declared; discoveries on a child's branch survive resume.

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
`/subagents` displays the catalog, tree and active-run count.

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
npm run check -w @oai404iao/pi-subagent
npm run ci
npm run ci:pi-matrix
```

Tests use scripted local models and actual Pi SDK runtimes, not live credentials.
MIT © 2026 oai404iao; upstream reference licenses/notices are retained separately.
