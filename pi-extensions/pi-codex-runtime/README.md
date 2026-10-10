# pi-codex-runtime

See the package guide below for release status; source edits do not publish artifacts.
It has no Pi extension entry
and does not automatically register tools or providers.

Peer floor and development target: Pi 0.99.1.

Owns shared Codex authentication/headers, wire identity, settings/catalog,
Responses replay contracts and the session-scoped composition broker.
Capability-specific HTTP clients, storage and transports live in other packages.

Tool activation changes only installed package tools. Core uses Pi's
`prepareLoadout.hiddenDeclarations` to hide selected `edit`/`write` declarations
while `apply_patch` is active, without changing their active or callable state.
Pi owns tool selection and its restoration across tree navigation, reload and
resume; explicitly disabled tools are never re-enabled by the plugin.

`openai` is the actively maintained OpenAI provider, for both API keys and
Pi's ChatGPT OAuth login. `openai-codex` is deprecated compatibility only;
its existing profiles remain, with a once-per-session migration warning.
Credentials, refresh and effective base URLs come from Pi. Legacy `apiKeyMode`
and `responses.endpoint` overrides do not route nonlegacy providers.

Global `codexRequestExtensions:true` preserves the existing request enhancements;
`false` gates wire metadata, Lite and native compaction without disabling
Standard tools. `endpoint_config` is a per-provider/auth-resolved-base-URL
capability allowlist, not a mode selector. Explicit unsupported responses are
tracked only for the live session and endpoint; no config or credentials are
rewritten. Tool projection waits for the first resolved request endpoint, while
execution always enforces the declaration. See the configuration guide.

Responses helpers encode/decode generic grammar tools and replay calls/results
according to the current declaration, preserving legacy custom patch behavior.

Configuration paths remain
`<agentDir>/extensions/pi-codex-minimal-tools/{config,models}.json`.
This package ships the canonical schemas and default catalog.
`openai/gpt-6.1-sol` inherits `openai/gpt-5.6-sol`: Lite, auto WS/SSE, prewarm,
standalone web/image, custom patch, native compaction and Fast availability
(priority, 2x cost multiplier), with `view_image` off. This compatibility
configuration is not evidence of endpoint access or verified Fast pricing.
Exact Standard profiles remain for `openai/gpt-6-astra`, `gpt-6-sol` and
`gpt-6-luna`, independently of the frozen legacy Lite profiles. Their default
tools are local custom `apply_patch` and `view_image`; remote tool/compaction
capabilities are not inferred from model names.
See `provenance/pi-openai-0991-gpt6.json` for the pinned Pi metadata and limits.
The global
`config.json.imageGeneration:false` setting gates image capability derivation
without replacing the selected model profile. Likewise,
`config.json.webSocketEnabled:false` forces SSE and disables WebSocket prewarm
without changing that profile.
`./subagent-inline` supplies the SDK identity integration and session Fast
inheritance. Its `openAIIdentity:false` option disables wire identity without
disabling Fast inheritance. `config.json.fastMode` is a new-session default;
runtime changes are persisted as non-context session entries, not config writes.
`./internal/*` is implementation wiring, not a stable public API.

Broker composition requires ABI v1 and matching runtime package versions.
See [the package guide](../../docs/codex-packages.md) for lifecycle and release
constraints. From repository root, run:

```bash
npm run check -w @oai404iao/pi-codex-runtime
npm run test:codex-composition
npm run test:codex-packages
```

Shared behavior regressions are in `tests/`. See the
[configuration guide](reference/configuration.md), [reference index](reference/README.md)
and [source map](reference/source-map.md). This package exclusively owns
[config.schema.json](config.schema.json) and [models.schema.json](models.schema.json);
the composition bundle no longer mirrors them.
