# Pi notifications — maintenance

Follow [root instructions](../../AGENTS.md) for repository workflow.
This is a non-private `publishable` workspace. Its verified `0.1.0` first publication
is locked; use [guarded publishing](../../RELEASING.md), never bootstrap again.
Read the [activation evidence](../../docs/audits/pi-notify-bootstrap-activation.md)
for registry identity and trusted-publisher verification boundaries. Use the root
lockfile and keep tests, `AGENTS.md` and private configuration out of the package allowlist.
Read [README.md](README.md) for supported terminals and manual checks.

## Ownership

- `index.ts` owns Pi event wiring, mode/child guards, stdout writes,
  per-channel deduplication and `/notify` / `/notify-test`.
- `src/notification.ts` owns Kitty OSC 99 encoding and tmux DCS passthrough.
  The default local channel needs no credentials or configuration.
- `src/settings.ts` owns all configuration at
  `<agent-dir>/extensions/pi-notify/config.json`: `channel` and the nested
  `telegram` enabled/credentials/timeout settings. Missing or invalid config
  defaults to `local`. Keep config reads and implementation within this package.
- `src/telegram.ts` owns terminal-result classification, MarkdownV2 formatting
  and timeout-bounded delivery. The standalone Telegram extension is independent;
  neither extension controls the other's settings, commands or registration.
- `tests/extension.test.ts` covers lifecycle, isolation and write failures;
  `tests/notification.test.ts` covers encoding and passthrough.

## Notification contracts

- The contracts below apply to local delivery. Telegram automatically notifies
  only user-started runs; waiting prompts require an active user run and `hasUI`.
  Ordinary parent RPC/print sessions can send Telegram. Check child identity at
  every send and reset run eligibility on settle and session transitions.
- Telegram sends the absolute project path and answer/error/prompt or dialog
  summary, as disclosed in the README. Preserve MarkdownV2 escaping, Unicode-safe
  truncation and timeout cleanup. Status output shows credential presence only;
  automatic failures are silent and explicit test failures must not expose secrets.
- Notify only on public `agent_settled`, after retries, compaction and queued
  work settle. Read the final assistant from the active `getBranch()`.
  `stop`/`length` show `Ready for input`; `error` shows `Stopped with an error`.
  Do not notify on `agent_end`, `toolUse`, `aborted` or blocking UI prompts.
  User and custom-message runs use the same completion policy.
- Suppress notifications when `agent_settled.aborted` is true, even if
  cancellation during retry wait leaves a final `error` or earlier `stop`.
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

- From the repository root, run `pnpm --filter @oai404iao/pi-notify run check`
  for implementation changes. It runs this package's TypeScript check and Node
  tests. For packaged path or entry-point changes, also run `pnpm run pack:check`
  and `pnpm run license:check`.
- Automated tests capture stdout and mock Telegram; they send no real notices.
  Preserve their environment/stdout restoration and isolation.
- Real-session loading and `/notify-test` require explicit authorization.
  Do not install the extension or change Pi/tmux configuration as part of a
  code check. Desktop display and click-to-focus need an authorized real desktop
  check: a successful stdout write alone proves neither.
