# @oai404iao/pi-codex-tools

## 0.1.0-alpha.1

### Minor Changes

- 64cc7e5: Move patch, web search and standalone image generation to the configurable
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

  The new tools workspace is prepared on the local bootstrap track for a separate
  manual first publication. Guarded publication remains disabled for tools until
  verified bootstrap and a separately reviewed activation; consumers publish later.

### Patch Changes

- Updated dependencies [64cc7e5]
  - @oai404iao/pi-codex-runtime@3.0.0
