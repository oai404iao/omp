---
"@oai404iao/pi-codex-core": major
"@oai404iao/pi-codex-runtime": major
"@oai404iao/pi-codex-tools": minor
"@oai404iao/pi-codex-minimal-tools": minor
"@oai404iao/pi-codex-web-search": minor
"@oai404iao/pi-codex-imagegen": minor
---

Move patch, web search and standalone image generation to the configurable
`pi-codex-tools` implementation. Core now installs only the Responses engine;
core-only users must also load tools to retain patch. The default bundle still
composes the complete experience; the old web/image entries select only their
own capability and share the tools implementation.

Keep the existing configuration paths and per-model selection. New global
`applyPatch` and `webSearch` booleans join `imageGeneration` as independent
default-on gates. Legacy model overrides are applied first, then intersected
with these gates and the loaded engine's actual capabilities.

Decouple Standard/Lite formatting, Codex request enhancements, transport and
native compaction. Preserve mandatory Lite signals and restrictions without
enabling Codex identity metadata, changing authentication or selecting another
endpoint. Separate opaque checkpoint replay protection from compaction
generation. Keep exact profile identity and explicit historical migrations.

Broker ABI v2 rejects older/incompatible brokers, snapshots owned protocol
descriptions for normal/prewarm/compaction requests, and never rewrites a
third-party tool just because its name is apply_patch.

The new tools workspace remains private/blocked pending separately authorized
publication preparation. No version bump or release activation is included.
