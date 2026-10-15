# @oai404iao/pi-codex-tools

Pi tools package owning `apply_patch`, `web_search` and `image_generation`,
including their execution, rendering and runtime assets. Its only workspace
dependency is `pi-codex-runtime`; it does not install the Responses engine.
Pi 1.2.0 is the supported floor and development target.

Install with `pi install /absolute/path/to/omp/pi-extensions/pi-codex-tools`
for local testing. This initial workspace is approved only for manual bootstrap;
it is not activated for guarded automated publication. See the
[first-publication sequence](../../RELEASING.md#codex-tools-first-publication).

## Composition

The default factory installs all three capabilities. The `./web-search` and
`./imagegen` factories install only their named capability. The legacy
`pi-codex-web-search` and `pi-codex-imagegen` packages delegate to those factories.
Broker claims deduplicate compatible combinations in either load order.
`pi-codex-minimal-tools` composes this package with `pi-codex-core`.

Standalone search and images use Pi's model-registry authentication and resolved
endpoint without core. Hosted search and custom/freeform patch require the
actual compatible Responses engine from core. An explicitly selected function
patch profile can run without core. Unsupported modes fail explicitly; there is
no implicit transport, account or endpoint fallback.

Native `edit`/`write` declarations are hidden only when patch is declared, through
Pi's `prepareLoadout`. They remain active, callable from codemode, and retained
in saved history. Patch structured results are `{ summary, files }`; search
returns `{ output, results }`; images return `{ path, latestPath?, image }`.
Image persistence, background `/image-gen`, preview and historical message types
are preserved. Local image inspection uses Pi's native `read`.

Patch rows honor Pi's `outputPad`, including zero-padding layouts. Rendering may
be deferred to another renderer. Failures reject instead of returning
success-shaped data. Pi passes retained structured results through even when a
`tool_result` hook sets `isError:true`; a hook requiring script rejection must
also replace `content` without supplying `structuredContent`.

Patch uses Pi's per-file mutation queues across the complete read/modify/write
window. Locks follow canonical target order; distinct aliases within one patch
(including hardlinks and move destinations) fail before mutation. Repeated actions
on one path are valid. Identity drift while waiting fails closed.
Queues coordinate participating tools, not arbitrary writers. Nonexistent files
use lexical keys, so separate calls through different directory aliases or
hardlinks do not guarantee shared locking. Keep paths consistent across tools;
concurrent directory/symlink replacement is not atomic filesystem isolation.

## Configuration

All factories keep the shared paths
`<agentDir>/extensions/pi-codex-minimal-tools/{config,models}.json`.
Runtime owns the schemas and exact model catalog.
Global `enabled:false` disables all tools. The default-true `applyPatch`,
`webSearch` and `imageGeneration` booleans independently prevent capability
registration, rendering and commands. Per-model overrides remain independent.
Do not create tool-specific configuration directories.

See the [configuration guide](../pi-codex-runtime/reference/configuration.md)
and [composition guide](../../docs/codex-packages.md).
Internal exports are package/test wiring, not stable user APIs.
Protocol evidence and adaptation notices are retained with the moved sources.

## Verification and license

Run `pnpm --filter @oai404iao/pi-codex-tools run check` from the repository root.
Composition and isolated tarball checks live in root `tests/codex/`.
No tests require real model credentials.
See [LICENSE](LICENSE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
