# pi-codex-web-search

See the package guide below for release status; source edits do not publish artifacts.

Peer floor and development target: Pi 0.99.1.

Global `endpoint_config.webSearch` allowlists are matched against Pi's resolved
provider/base URL. A denied or explicitly rejected mode is disabled, never
changed to hosted/standalone automatically. Runtime rejections are session-local;
`/reload` clears them. `codexRequestExtensions:false` omits generated standalone
search turn metadata while preserving authentication and search results.

Hosted search is model-only, including with native codemode in `only` mode.
Standalone search remains directly callable and is also available to codemode
while active. Exposure follows the selected model profile; this does not
enable codemode itself.

Codemode scripts receive `{ output, results }` instead of the model-facing text
alone. `output` retains citation references; `results` contains backend metadata
and may be empty. Authentication, HTTP and backend error sentinels reject the
call rather than resolving as successful structured data.
Pi intentionally resolves retained structured data if a `tool_result` hook
only sets `isError: true`. Such a hook must also replace `content` without
supplying `structuredContent` when it intends rejection or redaction.

Installs `web_search` and search activity rendering. Depends only on
`pi-codex-runtime`, not core, imagegen or the old bundle.
Catalog-supported standalone profiles call `alpha/search` using Pi's model
registry authentication. Hosted profiles require core; without it the tool stays
inactive and explicit execution reports the missing provider capability.

Standalone requests follow the pinned Codex `5a314017` search projection:
history ends at the latest visible user message and includes the preceding user
turn with a shared 1,000 approximate-token assistant budget (UTF-8 bytes, preserving
both ends when truncated). Available message metadata and phases are retained.
Empty history is omitted. Turn, model, reasoning, commands and history are
snapshotted before authentication; external-tool metadata excludes internal
Responses window/installation fields and does not invent Codex version or sandbox
telemetry.

Per-model `tools.webSearch` supports `mode` (`cached`, `indexed`, `live`),
`searchContextSize`, `userLocation`, `filters.allowedDomains`, and
`maxOutputTokens`. The output budget defaults to the pinned catalog's 10,000
tokens; `mode` defaults to `live` for compatibility. Search sends the selected
settings rather than overriding them with global live-access defaults.
Standalone HTTP requests retry network/5xx failures up to four times, matching
Codex's default policy; 429, explicit endpoint rejection and successful-response
backend error sentinels are not retried. Retry-After is honored, with advice over
60 seconds surfaced as a failure rather than retried prematurely.

When core is present, the broker contributes response-local search capture and
citation signatures without a second provider registration.
Uses the existing
`<agentDir>/extensions/pi-codex-minimal-tools/{config,models}.json` settings.
Unknown models are not enabled by inference.

The reserved endpoint is an unsupported compatibility surface, not a promise of
account access. `./internal/*` is implementation wiring.
See [the package guide](../../docs/codex-packages.md). From repository root:

```bash
pnpm --filter @oai404iao/pi-codex-web-search run check
pnpm run test:codex-composition
pnpm run test:codex-packages
```

Standalone client/activity/rendering regressions are in `tests/`; hosted transport
integration is in root `tests/codex/`. See the
[search protocol reference](reference/web-search-streaming-rendering.md) and
[shared configuration guide](../pi-codex-runtime/reference/configuration.md).
