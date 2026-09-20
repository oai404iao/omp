# Codex package composition

The four workspaces introduced in S3 are published at **`0.1.0-alpha.1`**.
This checkout activates their guarded recovery after independent registry and
trusted-publisher verification. The existing
`@oai404iao/pi-codex-minimal-tools` name becomes the compatibility bundle in this
checkout; its previously published tarballs are unchanged.

## Ownership

All package names below have the `@oai404iao/` scope.

| Package | Installs / owns | Workspace dependencies |
| --- | --- | --- |
| `pi-codex-runtime` | Library: auth/headers, identity, catalog/settings, replay contracts, broker | None; no `pi.extensions` |
| `pi-codex-core` | Responses SSE/WS, prewarm, compaction, apply_patch/view_image, diagnostics and fast commands | runtime |
| `pi-codex-web-search` | web_search, standalone alpha/search, activity/citation capture | runtime only |
| `pi-codex-imagegen` | image_generation, standalone Images API, background jobs, persistence/preview | runtime only |
| `pi-codex-minimal-tools` | Compatible default composition and old forwarding paths | runtime + all three capabilities |

All internal dependency versions are exact. Installing web or image alone does
not install core or the other capability. Core alone retains protocol/replay
knowledge of historical web/image items without loading image storage or search
presentation. This is code/install isolation, not a new sandbox or authorization
boundary. Existing reserved tool names must not be reused by unrelated tools.
Packages continue shipping TypeScript source for Pi/TS-aware loaders, not
compiled JavaScript for plain Node imports.

`./internal/*` exports support package wiring and compatibility forwards; they
are not stable user-facing APIs. The old bundle's `./subagent-inline` remains
supported, forwarding to runtime's identically named subpath.

## Model and configuration behavior

The default bundle keeps its existing tool names, activation, mutation-tool
suppression, commands, schemas, saved message types and wire formats.
Unknown or disabled model profiles remain on Pi's native implementation.
`openai-codex/gpt-6-astra` has an exact Responses Lite profile. Pi 0.85.1 is
the package floor and provides its model descriptor; core composes a stream
shim without replacing provider authentication, streams, or models.

All combinations read the same existing configuration:

```text
<agentDir>/extensions/pi-codex-minimal-tools/config.json
<agentDir>/extensions/pi-codex-minimal-tools/models.json
```

`PI_CODING_AGENT_DIR` still selects the agent directory. Existing project-level
settings precedence is unchanged. Runtime owns the canonical schemas/default
catalog; the bundle retains byte-checked compatibility copies. Do not create
parallel configuration directories named after the new capabilities.

Global `config.json.imageGeneration:false` is a generation kill switch. It
prevents image tool, command and presentation registration and blocks hosted,
standalone and direct-fallback execution without changing Responses mode,
transport, compaction, patch, web-search, image input or historical replay.
Per-model `tools.imageGeneration:false` remains an independent profile override.

Global `config.json.webSocketEnabled:false` forces Responses SSE and disables
WebSocket prewarm across model profiles without rewriting their catalog values.

Standalone clients obtain authentication from Pi's model registry. Without core:

- Catalog-supported `standalone` web/image profiles execute directly.
- Hosted search stays inactive and explicit execution reports that core is needed.
- Hosted image generation needs core, unless the existing
  `directImageApiFallback` setting was explicitly enabled.
- No endpoint or unsupported model-family capability is guessed.
- Missing authentication produces a tool error, not an implicit alternate account.

The internal Lite and reserved endpoints remain unsupported compatibility
surfaces. Fixture success is not proof that a real account may access them.

## Broker and lifecycle contract

`pi.events` synchronously discovers `@oai404iao/pi-codex:broker`. API wrappers and
module paths need not be identical. A session service claims package ownership
once; tools, providers, commands, renderers and identity hooks are not installed
again by a duplicate, cooperating package.

The handshake requires **ABI v1 and the same runtime package version**. Mixed
versions fail explicitly rather than selecting catalog semantics by load order.
The first package owns shared activation/presentation hooks; any later core
connects transport to the existing presentation service.

Stream effects snapshot contributions and image sinks before request I/O.
Observers remain response-attempt-local and run after normalization/continuation
capture, before replay. New/fork session starts invalidate display sinks; abort
blocks new image writes and completion notifications. Session clear alone does
not cancel or roll back file writes.

Shutdown disconnects discovery, flushes/clears presentation, aborts background
jobs and resets core prewarm/transports. Pi runtime invalidation also removes
tracked bus subscriptions. Reload discovers a fresh service, including when a
host reuses its event bus.

Duplicate-install support means **this broker-enabled bundle plus compatible
capability versions**. Mixing a pre-broker published monolith with new packages
is not covered: an unchanged old factory cannot participate in the handshake.
Upgrade the bundle to a broker-enabled release before mixing installations.

## Verification

### Optional Code Mode integration

The independent, private `pi-code-mode` package is not part of the Codex dependency
graph. Core and web-search may contribute data-returning adapters over its
versioned event protocol without importing that package. Explicit grants select
`codex_core__apply_patch` (exclusive write; existing executor, not root-confined)
and `codex_web__web_search` (parallel read; standalone profiles only). Installation
is not authorization. Hosted placeholders and image tools stay direct; Codex
auto-activation and direct-tool visibility are unchanged.

Core advertises its exact stream function on the optional grammar handshake.
Runtime handles generic grammar tool declarations, canonical string arguments,
escaped JSON deltas and replay for Standard/Lite SSE/WS; it does not special-case
Code Mode's `exec`. Selection still requires explicit model grammar metadata.
Switching to JSON changes call/result wire types without mutating saved messages.
See the [Code Mode guide](../pi-extensions/pi-code-mode/README.md) and
[S3 audit](audits/pi-code-mode-s3.md). Its installation tests independently check
the standalone package and optional Codex closure, using fixtures, not accounts.

From repository root:

```bash
npm ci --ignore-scripts
npm run ci
npm run changeset:status
```

`npm run test:codex-packages` packs all five Codex packages, npm-installs them in
temporary consumers, and uses the selected baseline's actual Pi loader. It covers runtime,
each capability, all pairs, all capabilities, the bundle, duplicate composition,
reversed order, separate physical runtime copies and shutdown/reload. Standalone
auth/HTTP are deterministic fixtures; there are no real credentials or endpoints.

Every Codex dependency in those consumers comes from a tarball and cannot resolve
back to workspace source. S4 installs external Pi/transport dependencies from
the root lock's exact registry tarballs using offline production `npm ci`.
The test projects only the production/host-peer closure, preserving nested
dependency versions and checksums, and checks that even executable symlinks
stay inside the consumer. It imports the consumer's own Pi loader, not the
workspace loader. The node_modules capability closure is independently asserted.
These tests deliberately use local Codex tarballs, not mutable registry installs;
they do not themselves verify publication or real endpoint/account access.
Separate registry and limited real-smoke evidence is recorded in the
[activation audit](audits/codex-bootstrap-activation.md).

Unit tests additionally exercise activation, unknown/disabled models, legacy
configuration, new/fork, no UI, abort, late image results and old replay fixtures.
Architecture checks include type/re-export edges, cycles, exported cross-package
paths, exact declared dependencies and forbidden optional/peer package edges.

## Release status

The four new packages are non-private on the guarded `publishable` track.
Their already-published versions are recovery nodes, pinned by source and SHA-512
in the release lock. Ordinary preparation includes them with the other five
alpha candidates; dependency closure may not be bypassed. A locked version
temporarily missing from registry metadata stops preparation, not triggers a
new publish. The tree-continue package stays private/blocked, and previous lock
entries remain unchanged.

S4 supplies `changeset:sync`, CI coverage checking and the guarded
`changeset:version` wrapper. Generated consumer changesets recurse through hard
and optional workspace dependencies; exact-pin changes require a consumer bump.
The publication pipeline independently validates dependency order, artifacts,
eligibility and dependency visibility, stopping downstream publication on failure.

Initial bootstrap is complete and this dedicated activation change was authorized
for review. Its merge and protected publication of the remaining five alpha
versions still need separate approval. The first four packages have both `next`
and `latest` pointing to their sole initial alpha; that bounded exception is not
stable-release acceptance. Trusted-publisher configuration is not proof of a
successful OIDC publish. See [activation evidence](audits/codex-bootstrap-activation.md)
and [RELEASING.md](../RELEASING.md).
The public package floor and current development target are both Pi 0.85.1.
The private tree-continue hook is audited for the same 0.85.1 baseline but
remains private/blocked. See
[Pi compatibility](pi-compatibility.md) for verification commands and limits.

The [integration review](audits/codex-integration.md) additionally checks cached
broker compatibility and restricts native placeholder rewriting to broker-owned
capabilities across extension requests, prewarm and compaction. Lower-level
helpers keep their legacy behavior when no ownership policy is supplied.
Background `/image-gen` jobs now have instance-owned status and cancellation:
session replacement/shutdown aborts work and suppresses late notifications and
new writes. Already-started server generation or file writes cannot be undone.
