# Telegram notifications — maintenance

Follow [root instructions](../../AGENTS.md) for workspace setup, changesets,
packaging and release authorization. Read [README.md](README.md) before changing
notification behavior or configuration.

## Ownership

- `index.ts` is the public entry facade; `src/index.ts` owns Pi event wiring,
  session state, deduplication and commands.
- `src/message.ts` owns terminal-result classification and MarkdownV2 formatting;
  `src/settings.ts` owns config resolution and validation;
  `src/telegram.ts` owns the timeout-bounded Bot API request.
- Keep configuration changes aligned with `config.schema.json`,
  `config.example.json`, the README and `tests/settings.test.ts`.

## Lifecycle and privacy contracts

- Completion/error notifications use `agent_settled`, not `agent_end`. Select the
  last assistant on `getBranch()`, not the last message in all session entries.
  `stop` and `length` mean completed; `error` means terminal failure;
  `toolUse` and `aborted` do not notify.
- Preserve assistant-entry deduplication and reset session state on
  `session_start` and `session_shutdown`.
- Waiting notifications use native `ui_prompt_start`, its title or fallback,
  and require `hasUI`. Pi coalesces overlapping dialogs; do not restore
  tool-name timers, questionnaire scraping or `rpiv:ask-user:prompt`.
  `ui_prompt_end` sends nothing.
- Check all `getEntries()` for `pi-subagent/descriptor` at notification time,
  including manual tests: descriptors may arrive after startup or lie off-branch.
  Do not classify ordinary non-UI sessions or user forks as subagents.
- Notifications send the absolute project directory and summary to Telegram.
  Summaries can include assistant text, errors or a fallback user prompt;
  truncation is not redaction. Preserve the README's privacy disclosure.
- Truncate dynamic content before MarkdownV2 escaping: summaries have a
  3000 UTF-16-unit budget and paths 512, without splitting Unicode code points.
  Raw summary Markdown stays literal; retain parsed-message length coverage.
- Preserve `<agent-dir>/extensions/pi-telegram-notify/config.json` and agent-dir
  precedence: `PI_CODING_AGENT_DIR`, existing XDG Pi directory, then `~/.pi/agent`.
  Status output reports credential presence, not the token.
- Automatic delivery is best-effort and must not interrupt Pi; explicit test
  commands report failures. Preserve request timeouts and timer cleanup.

## Verification and real sends

- From the repository root, run
  `pnpm --filter @oai404iao/pi-telegram-notify run check` for implementation changes.
  It runs TypeScript checking and `tests/**/*.test.ts`.
- Use `tests/extension.test.ts` for lifecycle/child isolation,
  `tests/message.test.ts` for formatting and `tests/telegram.test.ts` for transport.
  Keep automated delivery mocked with fake credentials.
- `/telegram-notify test` and `/telegram-notify:test` send real network messages.
  Run them only with explicit authorization; never use private config or real
  credentials as fixtures. Fixture success does not establish Telegram delivery.
