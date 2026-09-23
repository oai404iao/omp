# @oai404iao/pi-tree-continue

Adds `/continue` for Pi sessions. It resumes the agent without adding a new user
or custom message. Pi may append system prompt/tool updates before the request.

Compatibility: experimental against exactly Pi 0.87.0 and 0.87.1. It is not compatible by
contract with any Pi version.

> npm identity: `@oai404iao/pi-tree-continue`. This experimental package
> remains private and blocked from publication.

> **Unsupported private API hook.** Pi has no public extension API for
> message-free continuation. This package patches private `AgentSession`
> internals and is not safe to distribute or rely on for production workflows.
> It stays private until Pi provides an upstream continuation API with defined
> lifecycle, authentication, and branch-prompt semantics.

This is useful after transient provider failures such as 429s, network drops, or server errors where Pi is idle but the last useful point in the session is a `toolResult`.

## Install

For local experimentation only:

```bash
pi install ./pi-extensions/pi-tree-continue
```

Restart Pi or run `/reload` after installation.

## Commands

| Command | Action |
| --- | --- |
| `/continue` | Continue when the current branch ends at a `toolResult`, or at an empty assistant error/abort after a `toolResult`. |
| `/continue --force` | Also allow abandoning normal entries after the latest `toolResult`; otherwise preserve safe system updates. |

Unknown arguments are rejected so typos do not accidentally run as plain `/continue`.

## Behavior

`/continue` does **not** call `sendUserMessage()` or `sendMessage()`. It does not append a hidden custom message either.

Instead, it:

1. Finds the safe continuation `toolResult` on the current branch.
2. Uses Pi's tree navigation API to remove trailing empty errors while retaining safe system updates and metadata.
3. Initializes prompt state for legacy histories, otherwise preserves recorded prompt sections, and calls Pi's private run method with only the required system update or an empty message array.

By default, `/continue` is conservative. It only continues from the current leaf if the leaf is already a `toolResult`, or if everything after the latest `toolResult` consists of system updates, ignorable metadata, or empty assistant `error` / `aborted` entries. This avoids silently abandoning normal user or assistant messages.

Use `/continue --force` when you intentionally want to roll the branch back to the latest `toolResult` even if normal entries exist after it.

Selection uses the effective context, including append-only edits. `--force`
may discard a suffix but cannot restore omitted or replaced content. If no
existing branch preserves that prefix, the command refuses rather than silently
undoing an edit. Navigation and pending-message state are rechecked before running.

Because Pi does not currently expose a public extension API for message-free
continuation, this package installs a runtime hook into private
`AgentSession` fields. The hook reuses Pi's agent-run lifecycle (abort reset,
retries, prompt cleanup, and the `agent_settled` event) and checks the
selected model's configured auth before continuing, but it cannot emit
`before_agent_start` or reproduce Pi's branch-prompt semantics. Do not treat
it as equivalent to a normal user-initiated prompt.

## License and publication status

MIT © 2026 oai404iao. See [LICENSE](LICENSE).

This experimental package remains private until Pi exposes a supported
message-free continuation API. Tests alone cannot make the current private
hook safe across Pi versions.
