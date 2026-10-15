# pi-codex-core

See the package guide below for release status; source edits do not publish artifacts.

Peer floor and development target: Pi 1.2.0.

`codexRequestExtensions` defaults to `true`. Turning it off preserves
tool/replay handling but stops generated optional Codex metadata and separates WS
caches. Standard/Lite format, transport and native compaction stay independent;
mandatory Lite and compaction signals remain. Existing opaque checkpoints
are preserved and cannot silently become text summaries. Endpoint capability
allowlists and explicit session-local rejections are shared through runtime;
neither selects alternate implementations nor changes Pi authentication.

Core installs no tools. Add [`pi-codex-tools`](../pi-codex-tools/README.md) for
patch, search and images, or use the `pi-codex-minimal-tools` compatibility bundle.

While native `codemode` or `tool_search` is active, speculative WebSocket
prewarm is skipped because Pi does not expose the final `prepareLoadout` tool
projection. Compaction falls back to Pi's text summarization only when no opaque
native checkpoint exists. Existing native checkpoints are preserved and
recompaction is refused: disable both orchestration tools and retry `/compact`
on the original model, or navigate before the checkpoint. Other third-party
`prepareLoadout` implementations are not covered by this built-in-name guard.

Installs model-profiled Responses SSE/WebSocket transport, prewarm and compaction.
Local image inspection uses Pi's native `read` tool.
Keeps the existing diagnostic/fast command names,
including `/codex-minimal-tools` and `/fast`. Unknown models remain native.
`config.json.fastMode` supplies the default for new sessions. `/fast [on|off|status]`
changes only the current session and never rewrites that default. Selections
survive resume and `/reload`, follow the active session branch, and are copied
into forks/clones. Subagents follow the main agent's current selection on their
next request, including followups; requests already sent are unchanged. Models
without Fast support remain unaffected. Edit the config to change the default.
Pi supplies all descriptors; the extension does not register replacement models.
`openai/gpt-6.1-sol` inherits the `openai/gpt-5.6-sol` default profile:
Lite, auto WS/SSE, prewarm, native Responses compaction, custom patch and Fast
availability (priority, 2x cost multiplier). Patch and standalone web/image tools
require the tools package.
This is a compatibility configuration, not verified endpoint access or pricing.
The exact `openai/gpt-6-astra`, `gpt-6-sol` and `gpt-6-luna`
profiles retain Standard SSE with support for tools-owned custom patch. Remote
search/image generation, native compaction, prewarm and Fast stay off unless
explicitly configured. Their legacy `openai-codex` counterparts remain separate.

Both SSE and WebSocket forward parsed provider events through Pi's
`provider_stream_event` hook before normalization, in stream order.

Standard OpenAI Responses sampling merges Pi model defaults, the clamped Pi
thinking-level override, then request-level `samplingParams`, with later values
winning per key. Provider effort names are not sampling override keys.
Sampling cannot replace the request envelope, tools, identity, authentication,
cache or protocol controls. `max_output_tokens` requires model support and a
finite positive value, with a minimum of 16. ChatGPT subscription requests omit
temperature and output-token caps even when supplied through sampling parameters.
Lite merges only temperature; other new sampling fields remain unsupported.
Legacy `openai-codex` sampling behavior is unchanged.

The request envelope follows Codex `5a314017`: Standard and Lite use developer
prefix messages with thread-scoped deterministic IDs; Lite emits
`additional_tools` only when needed. Reasoning and verbosity defaults come from
the exact model profile. SSE and WS project the same captured identity and
execution metadata, while WS retains its transport-specific metadata fields.
Base prewarm accepts only the stable developer/tool prefix, never restored
conversation history. Pi authentication and explicit header suppression remain
authoritative; zstd is limited to verified official routes with prepared OAuth
credentials.

Native compaction now uses only Responses `compaction_trigger`; the unary
`/responses/compact` client has been removed. Historical opaque checkpoints
remain readable and guarded by their original model/profile; an unsupported
checkpoint is preserved rather than replaced with a placeholder text summary.
Exact earlier bundled profile hashes have a reviewed
old-to-new migration allowlist. Custom, legacy-overridden, unknown, or subsequently
changed profiles still fail closed rather than bypassing the profile guard.

Depends only on the shared runtime and its transport libraries; it does not
install patch, search or image clients/presentation. Protocol replay of old
web/image items does not enable their endpoints.

Grammar-capable models support generic constrained-sampling tools through both
Standard/Lite SSE and WebSocket, including canonical arguments and JSON/grammar
history switching. Tools contribute their custom declarations and input-property
mapping through ownership-validated broker descriptors; core does not load their
grammar, executor or renderer.

Uses the existing
`<agentDir>/extensions/pi-codex-minimal-tools/{config,models}.json` configuration
and Pi authentication. Set global `config.json.webSocketEnabled` to `false` to
force SSE and disable WebSocket prewarm across profiles. Add the tools package
when needed; the broker deduplicates cooperating
installations. Mixed runtime versions fail.

`./internal/*` is implementation wiring, not a stable public API.
See [the package guide](../../docs/codex-packages.md). From repository root:

```bash
pnpm --filter @oai404iao/pi-codex-core run check
pnpm run test:codex-composition
pnpm run test:codex-packages
```

Owner regressions and transport fixtures are in `tests/`. Protocol references:
[Standard Responses](reference/responses-standard.md),
[Responses Lite](reference/responses-lite.md),
[patch protocols](../pi-codex-tools/reference/apply-patch-protocols.md) and
[patch behavior](../pi-codex-tools/reference/apply-patch-behavior.md).
