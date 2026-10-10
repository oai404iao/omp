# Local Kitty notifications — maintenance

Follow [root instructions](../../AGENTS.md) for repository workflow.
This package is `private: true`, outside `pnpm-workspace.yaml` and npm release
batches. Use root-installed tooling; do not add publication metadata or another
lockfile. Read [README.md](README.md) for supported terminals and manual checks.

## Ownership

- `index.ts` owns Pi event wiring, mode/child guards, stdout writes,
  deduplication and `/local-notify-test`.
- `src/notification.ts` owns Kitty OSC 99 encoding and tmux DCS passthrough.
  This extension needs no credentials, config file or extra runtime dependency.
- `tests/extension.test.ts` covers lifecycle, isolation and write failures;
  `tests/notification.test.ts` covers encoding and passthrough.

## Notification contracts

- Notify only on public `agent_settled`, after retries, compaction and queued
  work settle. Read the final assistant from the active `getBranch()`.
  `stop`/`length` show `Ready for input`; `error` shows `Stopped with an error`.
  Do not notify on `agent_end`, `toolUse`, `aborted` or blocking UI prompts.
- A cancellation during retry wait may leave a final `error`; the settled
  event does not supply a cancellation reason. Do not claim otherwise.
- Deduplicate the last notified assistant entry, resetting on `session_start`
  and `session_shutdown`. A synchronous write failure must neither interrupt Pi
  nor mark the entry as notified, so a later attempt remains possible.
- Require `ctx.mode === "tui"`, terminal stdout and `KITTY_WINDOW_ID`.
  Never emit escapes into RPC, JSON, print or redirected output.
- Check all session entries for `pi-subagent/descriptor` at send time,
  including the test command; late descriptors must suppress child notifications.
- Send only the project directory name and fixed status to the local terminal,
  never prompts, answers or error details. The directory name is still visible
  on the desktop; no network service is involved.
- Keep OSC 99 title/body payloads base64-encoded so directory names cannot
  inject terminal controls. Preserve multipart IDs and completion markers.
- Normal notifications use `o=unfocused`; manual tests use `o=always`.
  `a=focus` requests focus on click, not proactively, and does not select a
  tmux window or pane.
- Detect tmux via `TMUX` or `TMUX_PANE`; wrap both OSC parts together in DCS
  passthrough and double every inner ESC. The extension does not modify tmux
  settings; nested tmux, SSH and Zellij are not supported adaptations.

## Verification and desktop authorization

- From the repository root, run `pnpm run check:local-notify` for implementation
  changes. It delegates to this package's TypeScript check and Node tests;
  a workspace package filter does not cover this private directory.
- Automated tests capture stdout and do not send real desktop notifications.
  Preserve their environment/stdout restoration and isolation.
- Real-session loading and `/local-notify-test` require explicit authorization.
  Do not install the extension or change Pi/tmux configuration as part of a
  code check. Desktop display and click-to-focus need an authorized real desktop
  check: a successful stdout write alone proves neither.
