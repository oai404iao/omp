# @oai404iao/pi-codex-minimal-tools

## 3.0.1

### Patch Changes

- 8af3b86: Update exact workspace dependency pins for the pending dependency releases.
- Updated dependencies [8af3b86]
- Updated dependencies [8af3b86]
- Updated dependencies [8af3b86]
- Updated dependencies [8af3b86]
- Updated dependencies [8af3b86]
- Updated dependencies [8af3b86]
  - @oai404iao/pi-codex-runtime@0.3.1
  - @oai404iao/pi-codex-core@0.3.1
  - @oai404iao/pi-codex-web-search@0.2.1
  - @oai404iao/pi-codex-imagegen@0.2.1

## 3.0.0

### Major Changes

- bb7e5ea: Require Pi 0.86.1 or newer. Adapt Codex streaming and native compaction to
  transcript-backed system prompts and tool declarations, keep inherited parent
  system authority out of child sessions, and recognize in-conversation OpenAI
  tool additions in External Thinking. Preserve the existing Codex wire formats,
  model profiles and publication eligibility. Keep Code Mode's already-restored
  direct tools available after historical tool-loadout restoration.

### Patch Changes

- Updated dependencies [ac5c2e5]
- Updated dependencies [bb7e5ea]
  - @oai404iao/pi-codex-runtime@0.3.0
  - @oai404iao/pi-codex-core@0.3.0
  - @oai404iao/pi-codex-web-search@0.2.0
  - @oai404iao/pi-codex-imagegen@0.2.0

## 2.1.0

### Minor Changes

- 99f497f: Add the global `webSocketEnabled` setting. It defaults to `true`; setting it to
  `false` forces Responses SSE and disables WebSocket prewarm across model
  profiles without changing their catalog values.
  
  Remove deprecated per-model compatibility keys from `config.schema.json`.
  Their one-version runtime migration remains available, but new configuration
  and editor completion now expose only supported global settings.

### Patch Changes

- Updated dependencies [99f497f]
- Updated dependencies [99f497f]
  - @oai404iao/pi-codex-runtime@0.2.0
  - @oai404iao/pi-codex-core@0.2.0
  - @oai404iao/pi-codex-imagegen@0.1.1
  - @oai404iao/pi-codex-web-search@0.1.1

## 2.0.0

### Major Changes

- fca54ca: Raise every public plugin's Pi peer floor to `>=0.85.1`. Pi 0.85.0 is excluded
  because its published SDK imports are broken; the private tree-continue
  experiment is audited for 0.85.1 too but remains blocked from publication.

### Minor Changes

- fca54ca: Add an exact `openai-codex/gpt-6-astra` Responses Lite profile using the model
  descriptor supplied by the supported Pi baseline.
  
  Promote `config.json.imageGeneration` to a global generation gate. Disabling it
  now omits image tools, background commands, presentation and provider injection,
  blocks standalone/direct execution before network I/O, and leaves all unrelated
  model-profile behavior unchanged.

### Patch Changes

- 76bea30: Expose each Pi extension through a package-root `index.ts` facade so compact
  startup summaries show the package name without an internal `:src` suffix.
  Package resource filters that explicitly selected `src/index.ts` must select
  `index.ts` instead.
- 952cb3f: Pin the supported-package development baseline to Pi 0.85.1 while retaining
  the Pi 0.84.2 peer floor. Add full floor/target compatibility verification,
  including independently installed Codex tarballs and real-loader checks.
  The private tree-continue hook remains exact-0.84.2 and disabled under the target
  loader. No Codex catalog, protocol, default capability or publication eligibility
  is changed.
- 952cb3f: Separate startup prewarm and image display lifecycles from provider registration,
  and inject image/web presentation observers instead of importing tool code from
  the transport. Existing registration and tools retain their default behavior.
  
  Cancel pending image-display timers and ignore late display callbacks after a
  session is replaced. Aborted image capture suppresses new persistence and
  completion notifications. Speculative prewarm authentication failures settle
  without leaking unhandled rejections or forcing HTTP fallback, and reset releases
  prewarm waiters even when an authentication lookup has not finished.
- 952cb3f: Split Codex ownership into a non-registering runtime library and independent core,
  web-search and image-generation packages. Retain the existing package name and
  subagent-inline entry as compatibility composition paths. Share capability and
  identity lifecycles through a version-checked session broker so equivalent package
  installations do not duplicate providers, tools, commands or renderers.
  
  New packages remain private/blocked. Release artifact preparation now rejects
  bundles with unpublished workspace dependencies; this change does not authorize
  their bootstrap or publication. Runtime versions must match when composing
  packages. Hosted capabilities still require core; standalone clients retain the
  existing catalog, Pi authentication, configuration paths and opt-in fallbacks.
- 32ba01f: Prepare the split Codex alpha cohort for separately approved, dependency-first
  bootstrap. Update package documentation and the four new manifests to reflect
  bootstrap eligibility, without enabling guarded publication or claiming real
  endpoint acceptance. The compatibility bundle requires the matching alpha
  dependencies; previously published monolith tarballs remain unchanged.
- 952cb3f: Separate Codex transport, replay, compaction, and tool presentation into internal
  modules while retaining existing entry points, tools, configuration, and wire
  behavior. Add compatibility and architecture regression coverage.
- Updated dependencies [fca54ca]
- Updated dependencies [76bea30]
- Updated dependencies [fca54ca]
- Updated dependencies [952cb3f]
- Updated dependencies [952cb3f]
- Updated dependencies [952cb3f]
- Updated dependencies [952cb3f]
- Updated dependencies [32ba01f]
- Updated dependencies [952cb3f]
  - @oai404iao/pi-codex-runtime@0.1.0
  - @oai404iao/pi-codex-core@0.1.0
  - @oai404iao/pi-codex-imagegen@0.1.0
  - @oai404iao/pi-codex-web-search@0.1.0

## 1.4.1-alpha.0

### Patch Changes

- 952cb3f: Pin the supported-package development baseline to Pi 0.85.1 while retaining
  the Pi 0.84.2 peer floor. Add full floor/target compatibility verification,
  including independently installed Codex tarballs and real-loader checks.
  The private tree-continue hook remains exact-0.84.2 and disabled under the target
  loader. No Codex catalog, protocol, default capability or publication eligibility
  is changed.
- 952cb3f: Separate startup prewarm and image display lifecycles from provider registration,
  and inject image/web presentation observers instead of importing tool code from
  the transport. Existing registration and tools retain their default behavior.

  Cancel pending image-display timers and ignore late display callbacks after a
  session is replaced. Aborted image capture suppresses new persistence and
  completion notifications. Speculative prewarm authentication failures settle
  without leaking unhandled rejections or forcing HTTP fallback, and reset releases
  prewarm waiters even when an authentication lookup has not finished.
- 952cb3f: Split Codex ownership into a non-registering runtime library and independent core,
  web-search and image-generation packages. Retain the existing package name and
  subagent-inline entry as compatibility composition paths. Share capability and
  identity lifecycles through a version-checked session broker so equivalent package
  installations do not duplicate providers, tools, commands or renderers.

  At this split-stage checkpoint, new packages remained private/blocked; the
  alpha-bootstrap preparation entry supersedes that status. Artifact preparation rejects
  bundles with unpublished workspace dependencies; this change does not authorize
  their bootstrap or publication. Runtime versions must match when composing
  packages. Hosted capabilities still require core; standalone clients retain the
  existing catalog, Pi authentication, configuration paths and opt-in fallbacks.
- Prepare the split Codex alpha cohort for separately approved, dependency-first
  bootstrap. Update package documentation and the four new manifests to reflect
  bootstrap eligibility, without enabling guarded publication or claiming real
  endpoint acceptance. The compatibility bundle requires the matching alpha
  dependencies; previously published monolith tarballs remain unchanged.
- 952cb3f: Separate Codex transport, replay, compaction, and tool presentation into internal
  modules while retaining existing entry points, tools, configuration, and wire
  behavior. Add compatibility and architecture regression coverage.
- Updated dependencies [952cb3f]
- Updated dependencies [952cb3f]
- Updated dependencies [952cb3f]
- Updated dependencies [952cb3f]
- Updated dependencies
- Updated dependencies [952cb3f]
  - @oai404iao/pi-codex-runtime@0.1.0-alpha.1
  - @oai404iao/pi-codex-core@0.1.0-alpha.1
  - @oai404iao/pi-codex-web-search@0.1.0-alpha.1
  - @oai404iao/pi-codex-imagegen@0.1.0-alpha.1

## 1.4.0

### Minor Changes

- c753cd9: Add Codex-owned session, thread, turn, and request identity lifecycle support,
  plus opt-in inline OpenAI Responses identity propagation for subagents.
