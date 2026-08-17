# pi-subagent

Durable, continuable subagents for [Pi](https://github.com/earendil-works/pi-mono). The design adapts the DeepSeek Harness subagent seam to Pi's extension and SDK APIs instead of copying Pi's subprocess-only example.

## Features

- **Named providers**
  - `spawn`: fresh child with no parent conversation
  - `fork`: one-shot child seeded through the parent's latest completed turn
- **Two lifecycles**
  - foreground one-shot runs return the child's final answer
  - background continuable runs return a child session id immediately
- **Foreground-only policy** that removes background scheduling from the delegation schema
- **Independent context and session** for every child
- **Materialized user presets** with update-time backup and replacement
- **Durable descriptors and lineage** stored in child JSONL sessions
- **Cold resume** through `send_message`
- **Control plane** with listing and interruption
- **Child-to-parent `report` channel** for continuable children
- **Nested delegation** with an absolute persisted depth limit
- **Dynamic agent-name enums** generated from the effective user/project catalog
- **Parallel-safe delegation**: multiple `subagent` calls in one assistant message may overlap
- **Composable tool ceilings** that preserve model/extension tool decisions
- **Usage accounting, streaming progress, output caps, and custom TUI rendering**

Children run through Pi's SDK in the same Node.js process, but each owns a separate `AgentSession`, context window, session file, tool selection, and extension runtime.

## Install

```bash
pi install /absolute/path/to/pi-extensions/pi-subagent
```

Restart Pi or run `/reload`.

For a temporary test:

```bash
pi -e /absolute/path/to/pi-extensions/pi-subagent
```

This implementation targets Pi `0.83.x`.

## Model-facing tools

| Tool | Behavior |
| --- | --- |
| `subagent` | Starts a fresh child. Background continuable mode is the default unless configured otherwise; foreground-only mode always waits for the answer. |
| `subagent_fork` | Starts a foreground one-shot child with the parent's completed-turn history. The in-flight tool turn is excluded. |
| `send_message` | Sends the next FIFO turn to a direct continuable child; cold-resumes a persisted child when needed. |
| `interrupt_agent` | Requests cancellation of a live descendant's current turn without deleting its session. |
| `list_agents` | Lists direct children or all descendants as `running`, `idle`, or `ready`. |
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

Pi executes sibling tool calls in parallel, so this package deliberately accepts one delegation per `subagent` call instead of embedding a separate `tasks` array.

## Agent definitions

The package includes `scout`, `planner`, `reviewer`, and `worker`. On extension startup,
these bundled definitions are materialized into:

```text
<Pi agent dir>/agents/*.md
```

Runtime discovery uses these user files rather than reading the package copies directly.
`/subagents` therefore reports the built-in presets as `(user)`.

Synchronization behavior:

1. **First startup:** missing presets are installed. A different pre-existing same-name file
   is backed up before the bundled version replaces it.
2. **Ordinary restart of the same release:** user edits are preserved.
3. **Plugin update:** differing user presets are backed up, then replaced with the new
   bundled versions. A bundled prompt hash change also triggers this refresh even if the
   package version was not bumped.
4. **Retired preset:** a formerly bundled name is backed up and removed so an obsolete
   prompt does not remain silently active.
5. Files whose names were never managed bundled presets are left untouched.

Synchronization holds a cross-process lock, then preflights and stages the whole update
before changing agent files. If a commit fails, it rolls back already-applied changes and
fails extension startup rather than falling back to package prompts. Same-name symbolic
links are preserved as symbolic links inside the backup directory before the user path is
replaced. An invalid synchronization manifest is copied to a timestamped `.corrupt-*` file
and startup fails closed until the manifest is repaired or deliberately removed.

Synchronization state and backups live at:

```text
<Pi agent dir>/.pi-subagent/agents-manifest.json
<Pi agent dir>/.pi-subagent/backups/<timestamp>-to-<version>/*.md
```

The startup notification reports installed/updated files and exact backup paths. To restore
a customization after an update, copy its backup over the corresponding user agent file;
later startups of that same plugin release preserve the restored edit.

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

Runtime locations and precedence:

1. `<Pi agent dir>/agents/*.md`
2. nearest trusted `.pi/agents/*.md`

Project definitions replace user definitions with the same name when project scope is
enabled. Project agents are disabled by the default `agentScope: "user"`. Setting the scope
to `project` explicitly selects only project definitions; `both` loads user definitions
followed by project overrides.

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

The reserved logical tool `$mutation` lets one definition work with both standard Pi and
model-specific tool extensions:

- if an inherited extension leaves `apply_patch` active, `$mutation` resolves to `apply_patch`;
- otherwise it resolves to the active built-in `edit` and/or `write` tools;
- if no mutation implementation is active, child creation fails before the first model request.

The bundled `worker` uses `$mutation`. For example, to use
`pi-codex-minimal-tools` inside workers:

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
  "reportDelivery": "wakeup",
  "inheritExtensions": false,
  "maxOutputBytes": 51200
}
```

| Setting | Default | Meaning |
| --- | --- | --- |
| `agentScope` | `user` | Select user definitions, project definitions, or user definitions followed by project overrides. |
| `maxDepth` | `3` | Absolute delegation depth; a top-level Pi session is depth 0. |
| `enableRunInBackground` | `true` | Allow fresh continuable background children. Set `false` for foreground-only mode. |
| `defaultBackground` | `true` | Default scheduling for fresh `subagent` calls when background execution is enabled. |
| `reportDelivery` | `wakeup` | `wakeup` starts/queues a parent turn; `quiet` waits for the parent's next turn. |
| `inheritExtensions` | `false` | Load other Pi extensions in child runtimes. This package filters itself out; explicit agent tool ceilings still apply. |
| `maxOutputBytes` | `51200` | Cap for parent-visible foreground output, reports, and settlement notices. Full output remains in the child session. |

Invalid configuration and unknown child tool names fail loud before the child's first model request.

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
- sibling foreground calls may still execute in parallel in one assistant message.

`subagent_fork` is already foreground-only and is unchanged. Background control tools remain
available so existing persisted children can still be listed, interrupted, or resumed. Run
`/reload` or restart Pi after changing this setting so the displayed tool schema is refreshed.

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

The start tool resolves at prompt preflight acceptance and returns the stable child session id. When an activation settles:

1. the runtime sends the parent a settlement notice with the stop reason and closing message;
2. the child runtime is disposed once its owned descendants are done;
3. its persistent session becomes `ready`;
4. `send_message` can cold-resume that same session for another FIFO turn.

A child can explicitly call `report` before settlement. Reports and settlement notices are separate by design.

### Fork boundary

The parent is executing a tool when `subagent_fork` starts, so its current assistant/tool-result sequence is incomplete. The provider copies only through the latest assistant message whose stop reason is not `toolUse`. This avoids seeding an invalid unbalanced tool turn.

## Security

- Extensions and subagents run with the user's OS permissions.
- Startup synchronizes bundled presets into the user agent directory and may create backups under `<Pi agent dir>/.pi-subagent/backups`.
- Project-local agents are repository-controlled prompts. They are loaded only when the project is trusted and configuration enables project scope.
- `inheritExtensions` is disabled by default because loading an extension in a child executes its code and may duplicate external side effects.
- Explicit agent tool lists are enforced as registry ceilings, but this controls model visibility and execution composition rather than providing an OS sandbox.
- A child may send content only to its recorded direct parent through `report`; `send_message` likewise requires direct-parent identity.

## Current limitations

- Activations and ownership are process-local; there is no cross-process lease or durable mailbox.
- Pi does not expose stable inbox message ids, so control acknowledgements return the child id rather than a delivery id.
- A process crash can lose a prompt accepted just before Pi writes it to the child JSONL; there is no durable mailbox for accepted-but-unlogged work.
- `interrupt_agent` is fire-and-return and relies on Pi's current `AgentSession.abort()` queue behavior.
- The fork provider is intentionally one-shot.
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
