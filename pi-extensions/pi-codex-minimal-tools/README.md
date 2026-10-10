# @oai404iao/pi-codex-minimal-tools

Composition-only entry for Pi's Codex extensions. It loads:

- [`pi-codex-core`](../pi-codex-core/README.md): Responses transport, compaction,
  `apply_patch`, `view_image` and diagnostics.
- [`pi-codex-web-search`](../pi-codex-web-search/README.md): hosted/standalone search.
- [`pi-codex-imagegen`](../pi-codex-imagegen/README.md): image generation and display.

All three use [`pi-codex-runtime`](../pi-codex-runtime/README.md). Compatible
duplicate installations are deduplicated by the shared broker.
Peer floor and development target: Pi 0.99.1.

Use Pi's `openai` provider for API keys or ChatGPT OAuth (`/login openai`).
`openai-codex` remains deprecated compatibility only. No credentials, model
selection or session history are migrated automatically. New requests follow
Pi's API/base URL rather than plugin `apiKeyMode` or `responses.endpoint`
overrides outside the legacy provider.

`openai/gpt-6.1-sol` defaults to the same profile as `openai/gpt-5.6-sol`:
Lite, auto WS/SSE, prewarm, standalone web/image, custom patch, native compaction
and Fast availability (priority, 2x cost multiplier). `view_image` is off.
These defaults do not establish real-account endpoint access or Fast pricing.
Exact profiles for `openai/gpt-6-astra`, `gpt-6-sol` and
`gpt-6-luna` retain Standard SSE with local custom patch and image viewing.
Remote search/image generation, native compaction, prewarm and Fast default
off. Enable only the implementations you intend to use in the model profile,
and declare endpoint support separately; allowlists do not enable tools.

Native codemode may call active `apply_patch` and standalone web/image tools.
Hosted web/image tools and `view_image` remain model-only. The bundle does not
activate codemode or load MCP servers.
Script results are structured: patch `{ summary, files }`, search
`{ output, results }`, and image generation `{ path, latestPath?, image }`.
With native codemode/tool-search active, core skips speculative prewarm and
uses Pi text compaction only without an existing opaque native checkpoint;
otherwise it preserves the checkpoint and refuses recompaction.

The package name, default extension factory and
`@oai404iao/pi-codex-minimal-tools/subagent-inline` remain supported.
The latter re-exports runtime's identity-only SDK extension.

## Configuration and installation

Existing configuration stays at
`<agentDir>/extensions/pi-codex-minimal-tools/{config,models}.json`.
The file locations are unchanged. Move nonlegacy endpoint overrides to Pi's
own `models.json`. Image execution is standalone-only and uses that provider's
Pi credentials and endpoint; remove the obsolete `directImageApiFallback` setting.
Schemas belong only to runtime:

- [config.schema.json](https://unpkg.com/@oai404iao/pi-codex-runtime/config.schema.json)
- [models.schema.json](https://unpkg.com/@oai404iao/pi-codex-runtime/models.schema.json)

Global `codexRequestExtensions` defaults to `true`. Set it to `false` to stop
plugin-generated Codex wire metadata and enhancements while keeping Standard
tools and hosted result handling; Lite requests and incompatible opaque
checkpoint transitions are blocked rather than silently downgraded.

`endpoint_config` accepts exact `{ provider, baseUrl, webSearch?, imageGeneration?,
compaction? }` entries. Search lists contain `"hosted"`/`"standalone"`; image lists
contain only `"standalone"` and compaction lists only `"responses"`. Omitted lists inherit the
model profile, `[]` denies the capability, and lists never select a fallback.
Matching uses Pi's authenticated endpoint. Explicit unsupported responses warn
and disable that mode only for the current session/endpoint, without changing
credentials or writing config. See the configuration guide for an example and
error-classification limits; `/reload` clears transient rejections.

Old version-pinned `pi-codex-minimal-tools@1` schema URLs still refer to their
unchanged published artifacts. This checkout no longer duplicates schemas or
private `src/*` forwards in the bundle.

See the [configuration guide](https://github.com/oai404iao/omp/blob/main/pi-extensions/pi-codex-runtime/reference/configuration.md)
and [installation/composition guide](https://github.com/oai404iao/omp/blob/main/docs/codex-packages.md).
For local testing, run root `pnpm install --frozen-lockfile --ignore-scripts`, then
`pi install /absolute/path/to/omp/pi-extensions/pi-codex-minimal-tools`.
These source changes do not themselves publish a new npm release.

Tests live with their implementation owners; cross-package tests are in root
`tests/codex/`. Protocol references and provenance are indexed in runtime's
[source map](https://github.com/oai404iao/omp/blob/main/pi-extensions/pi-codex-runtime/reference/source-map.md).
Responses Lite is an internal compatibility path, not a supported public API.

## License

The composition entry is [MIT](LICENSE). Dependencies retain their own licenses
and source notices; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
