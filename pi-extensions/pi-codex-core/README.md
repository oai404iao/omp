# pi-codex-core

Alpha bootstrap candidate; initial npm publication is still pending.

Peer floor: Pi 0.87.0; development target: 0.87.1.

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

`apply_patch` participates in Pi's native per-file mutation queues across its
whole read/modify/write window. Multi-file locks follow canonical target order.
Use one consistent path for each target within a patch: distinct paths aliasing
the same file are rejected before mutation, including hardlinks, aliases through
directory symlinks and move destinations. Existing targets also use device/inode
snapshots for alias and replacement checks, without changing native path-based
lock keys or lock ordering. Repeated actions on the same path remain valid.
Unresolvable identities or identity changes while waiting fail closed; retry
with stable paths rather than bypassing the queue.

These queues coordinate participating tools, not arbitrary filesystem writers.
Pi uses lexical keys for nonexistent files, so separate invocations creating a
new file through different directory aliases do not have guaranteed shared
locking. Separate calls through different hardlinks likewise do not share a
native queue. Use consistent paths across tools as well; concurrent directory/symlink
replacement is not an atomic filesystem isolation guarantee.

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
