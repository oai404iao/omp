# @oai404iao/pi-codex-minimal-tools

Composition-only entry for Pi's Codex extensions. It loads:

- [`pi-codex-core`](../pi-codex-core/README.md): Responses transport, compaction,
  `apply_patch`, `view_image` and diagnostics.
- [`pi-codex-web-search`](../pi-codex-web-search/README.md): hosted/standalone search.
- [`pi-codex-imagegen`](../pi-codex-imagegen/README.md): image generation and display.

All three use [`pi-codex-runtime`](../pi-codex-runtime/README.md). Compatible
duplicate installations are deduplicated by the shared broker.
Peer floor: Pi 0.87.0; development target: 0.87.1.

The package name, default extension factory and
`@oai404iao/pi-codex-minimal-tools/subagent-inline` remain supported.
The latter re-exports runtime's identity-only SDK extension.

## Configuration and installation

Existing configuration stays at
`<agentDir>/extensions/pi-codex-minimal-tools/{config,models}.json`.
No user-file migration is needed. Schemas now belong only to runtime:

- [config.schema.json](https://unpkg.com/@oai404iao/pi-codex-runtime/config.schema.json)
- [models.schema.json](https://unpkg.com/@oai404iao/pi-codex-runtime/models.schema.json)

Old version-pinned `pi-codex-minimal-tools@1` schema URLs still refer to their
unchanged published artifacts. This checkout no longer duplicates schemas or
private `src/*` forwards in the bundle.

See the [configuration guide](https://github.com/oai404iao/omp/blob/main/pi-extensions/pi-codex-runtime/reference/configuration.md)
and [installation/composition guide](https://github.com/oai404iao/omp/blob/main/docs/codex-packages.md).
For local testing, run root `npm ci --ignore-scripts`, then
`pi install /absolute/path/to/omp/pi-extensions/pi-codex-minimal-tools`.
These source changes do not themselves publish a new npm release.

Tests live with their implementation owners; cross-package tests are in root
`tests/codex/`. Protocol references and provenance are indexed in runtime's
[source map](https://github.com/oai404iao/omp/blob/main/pi-extensions/pi-codex-runtime/reference/source-map.md).
Responses Lite is an internal compatibility path, not a supported public API.

## License

The composition entry is [MIT](LICENSE). Dependencies retain their own licenses
and source notices; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
