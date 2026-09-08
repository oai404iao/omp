# pi-codex-core

Private/blocked S3 extension; not published to npm.

Installs model-profiled Responses SSE/WebSocket transport, prewarm, compaction,
`apply_patch` and `view_image`. Keeps the existing diagnostic/fast command names,
including `/codex-minimal-tools` and `/fast`. Unknown models remain native.

Depends only on the shared runtime and its transport libraries; it does not
install web-search or image-generation clients/presentation. Protocol replay of
old web/image items does not enable their endpoints.

Uses the existing
`<agentDir>/extensions/pi-codex-minimal-tools/{config,models}.json` configuration
and Pi authentication. Add matching web/image capability packages when needed;
the broker deduplicates cooperating installations. Mixed runtime versions fail.

`./internal/*` is implementation wiring, not a stable public API.
See [the package guide](../../docs/codex-packages.md). From repository root:

```bash
npm run check -w @oai404iao/pi-codex-core
npm run test:codex-packages
```
