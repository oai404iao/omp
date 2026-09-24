# pi-codex-runtime

See the package guide below for release status; source edits do not publish artifacts.
It has no Pi extension entry
and does not automatically register tools or providers.

Peer floor: Pi 0.87.0; development target: 0.87.1.

Owns shared Codex authentication/headers, wire identity, settings/catalog,
Responses replay contracts and the session-scoped composition broker.
Capability-specific HTTP clients, storage and transports live in other packages.

Responses helpers encode/decode generic grammar tools and replay calls/results
according to the current declaration, preserving legacy custom patch behavior.
An internal structural event adapter lets owners offer optional Code Mode
contributions without importing or depending on the private Code Mode package.

Configuration paths remain
`<agentDir>/extensions/pi-codex-minimal-tools/{config,models}.json`.
This package ships the canonical schemas and default catalog, including the
`openai-codex/gpt-6-astra` Responses Lite profile. The global
`config.json.imageGeneration:false` setting gates image capability derivation
without replacing the selected model profile. Likewise,
`config.json.webSocketEnabled:false` forces SSE and disables WebSocket prewarm
without changing that profile.
`./subagent-inline` supplies the existing SDK identity integration.
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
