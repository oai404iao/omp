# pi-tree-continue

Adds `/continue` for Pi sessions. It resumes the agent without adding any new message to the LLM context.

This is useful after transient provider failures such as 429s, network drops, or server errors where Pi is idle but the last useful point in the session is a `toolResult`.

## Install

Install as a local Pi package:

```bash
pi install /absolute/path/to/pi-tree-continue
```

Restart Pi or run `/reload` after installation.

## Commands

| Command | Action |
| --- | --- |
| `/continue` | Continue when the current branch ends at a `toolResult`, or at an empty assistant error/abort after a `toolResult`. |
| `/continue --force` | Jump back to the latest `toolResult` anywhere on the current branch, abandoning later entries. |

Unknown arguments are rejected so typos do not accidentally run as plain `/continue`.

## Behavior

`/continue` does **not** call `sendUserMessage()` or `sendMessage()`. It does not append a hidden custom message either.

Instead, it:

1. Finds the safe continuation `toolResult` on the current branch.
2. Uses Pi's tree navigation API to make that tool result the active leaf when needed.
3. Calls Pi's internal agent continuation path, the same kind of continuation Pi normally runs after tool results.

By default, `/continue` is conservative. It only continues from the current leaf if the leaf is already a `toolResult`, or if everything after the latest `toolResult` is ignorable metadata plus an empty assistant `error` / `aborted` entry. This avoids silently abandoning normal user or assistant messages.

Use `/continue --force` when you intentionally want to roll the branch back to the latest `toolResult` even if normal entries exist after it.

Because Pi does not currently expose a public extension API for message-free continuation, this package installs a small runtime hook into `AgentSession` to access the active session's internal `agent.continue()` method.

## License and publication status

MIT © 2026 oai404iao. See [LICENSE](LICENSE).

This experimental package remains private until its internal Pi API dependency
has tests and a reviewed compatibility policy.
