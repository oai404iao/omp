# pi-codex-core

Alpha bootstrap candidate; initial npm publication is still pending.

Peer floor: Pi 0.86.1; tested against 0.86.1.

Installs model-profiled Responses SSE/WebSocket transport, prewarm, compaction,
`apply_patch` and `view_image`. Keeps the existing diagnostic/fast command names,
including `/codex-minimal-tools` and `/fast`. Unknown models remain native.
It supplies the Astra descriptor only when the Pi floor catalog lacks it; newer
Pi catalogs retain their native provider model list.

Depends only on the shared runtime and its transport libraries; it does not
install web-search or image-generation clients/presentation. Protocol replay of
old web/image items does not enable their endpoints.

Grammar-capable models support generic constrained-sampling tools through both
Standard/Lite SSE and WebSocket, including canonical arguments and JSON/grammar
history switching. Optional Code Mode discovery offers `codex_core__apply_patch`
using the existing executor (not root-confined); an exact Code Mode grant is
required. Core has no dependency on Code Mode and does not hide the direct tool.

Uses the existing
`<agentDir>/extensions/pi-codex-minimal-tools/{config,models}.json` configuration
and Pi authentication. Set global `config.json.webSocketEnabled` to `false` to
force SSE and disable WebSocket prewarm across profiles. Add matching web/image
capability packages when needed; the broker deduplicates cooperating
installations. Mixed runtime versions fail.

`./internal/*` is implementation wiring, not a stable public API.
See [the package guide](../../docs/codex-packages.md). From repository root:

```bash
npm run check -w @oai404iao/pi-codex-core
npm run test:codex-packages
```
