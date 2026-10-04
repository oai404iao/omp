# @oai404iao/pi-codex-minimal-tools

## 4.1.0

Final model defaults: `openai/gpt-6.1-sol` uses the GPT-5.6 Sol Lite profile
described below, superseding its initial Standard profile in this release.
The other modern GPT-6 profiles remain Standard.

### Minor Changes

- 92c0a63: Make the Codex bundle composition-only while preserving its default and
  subagent-inline exports and existing configuration paths. Remove private source
  forwards and duplicate schemas/assets; runtime owns canonical schemas and
  catalog, and core owns the grammar. Move behavioral tests, protocol references,
  preview assets and source/license documentation to their owners, with
  cross-package regression tests at repository root. Retain upstream fingerprints
  and enforce the thin bundle through architecture, license and tarball checks.
- 2632cb0: Add the default-on codexRequestExtensions wire-enhancement gate and exact
  provider/auth-resolved-base-URL endpoint_config capability allowlists.
  Preserve Standard hosted/standalone tools while blocking incompatible Lite and
  opaque-checkpoint transitions. Explicit unsupported protocol responses warn and
  disable only the affected mode for the current session/endpoint, with no automatic
  provider/implementation fallback or persistent configuration changes.
- 2632cb0: Add exact Standard Responses profiles for openai/gpt-6.1-sol, gpt-6-astra,
  gpt-6-sol and gpt-6-luna from pinned Pi 0.99.1 metadata. Enable local custom
  patch and image viewing without inferring remote tool, compaction, WebSocket
  or Fast support. Standard OpenAI reasoning clamps use Pi's public implementation.
  Keep legacy Codex profiles frozen and document explicit authentication, model,
  endpoint-capability and opaque-checkpoint migration boundaries.
- 2632cb0: Provide structured script results for patching, standalone search and image
  generation while keeping hosted and subagent tools model-only. Child sessions
  load native codemode/tool-search through the inherited builtin policy, preserve
  hard registry ceilings and deferred discoveries across cold resumes, and report
  nested trace IDs without double-counting usage. Child codemode does not expose
  classifier/model calls; built-in MCP is not injected.

  Skip speculative prewarm with native codemode/tool-search active. In that state,
  use Pi text compaction only without an opaque native checkpoint; otherwise
  preserve the checkpoint and refuse recompaction rather than guessing the
  request tool projection. Disable both tools and retry on the original model,
  or navigate before the checkpoint.
- 2632cb0: Require Pi 0.99.1. Keep hosted Codex tools, image viewing, and all subagent
  delegation/control tools model-only; allow active standalone Codex tools through
  native codemode. Follow model changes without reactivating manually disabled
  tools, and reject hosted placeholder execution as an error. Handle Pi's explicit
  prompt dispositions without accepting a handled input as a child task.

  This does not enable codemode/MCP, add model profiles, or change authentication.
- 2632cb0: Follow Pi's native OpenAI authentication and API routing, including ChatGPT OAuth
  request-field compatibility and resolved base URLs for auxiliary requests.
  Treat openai-codex as deprecated compatibility without migrating credentials or
  history. Outside that legacy provider, apiKeyMode and responses.endpoint no longer
  override Pi's API/base URL. Explicit direct image fallback now uses the selected
  provider's Pi authentication instead of a separate environment key/account.

### Patch Changes

- 719c607: Forward raw provider events before Codex SSE/WebSocket normalization and prepare
  subagent Codex identity for virtual model selections, preserving identity across
  routing changes and cold resumes without adding identity to model context.

  Align the default `openai/gpt-6.1-sol` profile with `openai/gpt-5.6-sol`: Lite,
  auto transport, prewarm, standalone web/image, custom patch, native compaction
  and priority Fast availability with a 2x cost multiplier. Keep other GPT-6 and
  legacy Codex profiles unchanged. These defaults do not establish real-account
  endpoint access or verified Fast pricing.
- Updated dependencies [92c0a63]
- Updated dependencies [2632cb0]
- Updated dependencies [92c0a63]
- Updated dependencies [2632cb0]
- Updated dependencies [2632cb0]
- Updated dependencies [2632cb0]
- Updated dependencies [2632cb0]
- Updated dependencies [719c607]
- Updated dependencies [5e57992]
  - @oai404iao/pi-codex-runtime@0.5.0
  - @oai404iao/pi-codex-core@0.5.0
  - @oai404iao/pi-codex-web-search@0.4.0
  - @oai404iao/pi-codex-imagegen@0.4.0

## 4.0.0

### Major Changes

- 326891d: Require Pi 0.87.0 or newer and target 0.87.1. Respect canonical context edits in
  child inheritance, grammar eligibility and message-free continuation, and collect
  child results from finalized events rather than a mutable context offset.
  
  Native compaction now writes retain-none v4 checkpoints and preserves composed
  context transforms without restoring old system/tool state. Legacy checkpoints
  still replay unchanged contexts; if an earlier context transform changes them,
  the run stops with a request to recompact on the original model instead of
  reviving filtered content. Failed recompression preserves the existing checkpoint.
  
  Add evidence-backed exact Codex GPT-6 Sol/Luna profiles and preserve their
  descriptor's Off reasoning mapping. No guessed fast-mode billing, ultra effort,
  context size override or public-API cache TTL is added to Codex Lite.
  Notifications and cleanup remain on agent_settled; boundary continuation and
  deferred settled runs have real SDK regression coverage.

### Patch Changes

- Updated dependencies [326891d]
  - @oai404iao/pi-codex-runtime@0.4.0
  - @oai404iao/pi-codex-core@0.4.0
  - @oai404iao/pi-codex-web-search@0.3.0
  - @oai404iao/pi-codex-imagegen@0.3.0

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
