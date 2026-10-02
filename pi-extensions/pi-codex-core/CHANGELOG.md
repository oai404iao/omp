# @oai404iao/pi-codex-core

## 0.5.0

### Minor Changes

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
  
  The private tree-continue hook remains disabled on this unaudited Pi version.
  This does not enable codemode/MCP, add model profiles, or change authentication.
- 2632cb0: Follow Pi's native OpenAI authentication and API routing, including ChatGPT OAuth
  request-field compatibility and resolved base URLs for auxiliary requests.
  Treat openai-codex as deprecated compatibility without migrating credentials or
  history. Outside that legacy provider, apiKeyMode and responses.endpoint no longer
  override Pi's API/base URL. Explicit direct image fallback now uses the selected
  provider's Pi authentication instead of a separate environment key/account.

### Patch Changes

- 92c0a63: Make the Codex bundle composition-only while preserving its default and
  subagent-inline exports and existing configuration paths. Remove private source
  forwards and duplicate schemas/assets; runtime owns canonical schemas and
  catalog, and core owns the grammar. Move behavioral tests, protocol references,
  preview assets and source/license documentation to their owners, with
  cross-package regression tests at repository root. Retain upstream fingerprints
  and enforce the thin bundle through architecture, license and tarball checks.
- 92c0a63: Fix Codex SSE cancellation after response headers, flush residual EOF frames,
  and preserve CRLF/Unicode across chunk boundaries. Reject unsuccessful terminal
  responses before emitting done or retaining WebSocket continuation state, and
  distinguish output-token limits from other incomplete responses.
  
  Honor explicit SSE maxRetries, Retry-After and maxRetryDelayMs while retaining
  the default three retries and non-retryable HTTP error handling. Release retry
  sleep abort listeners after settlement.
  
  Account for cache-write tokens and clamp fresh input usage. Backfill late
  encrypted reasoning signatures without replacing existing replay data.
  Honor injected fetch, provider-scoped proxy environments, cacheRetention none,
  and WebSocket connect/idle timeout options. Separate socket reuse by effective
  proxy route and keep shared-connection waits independently cancellable.
  
  Fail closed on malformed SSE JSON and stop retrying explicit quota exhaustion,
  including streaming compaction errors. Use zstd only when it reduces request
  bytes on the exact built-in Codex SSE endpoint; preserve custom endpoint and
  WebSocket request encoding.
- 5e57992: Remove integration with the retired private Code Mode extension. Keep Codex
  apply_patch and web_search registered as direct Pi tools, and retain native
  edit/write restoration and foreign-tool ownership checks.
- Updated dependencies [92c0a63]
- Updated dependencies [2632cb0]
- Updated dependencies [92c0a63]
- Updated dependencies [2632cb0]
- Updated dependencies [2632cb0]
- Updated dependencies [2632cb0]
- Updated dependencies [5e57992]
  - @oai404iao/pi-codex-runtime@0.5.0

## 0.4.0

### Minor Changes

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

## 0.3.1

### Patch Changes

- 8af3b86: Complete v2 contribution declarations, bounded consumer generations/revision
  checks, public structural unsettled-effect errors, classified/coalesced refresh,
  Codex's optional structural client and transcript-aware transport negotiation.
  Add explicit, default-off inventory and native-local ls pilots with exact grants;
  keep subagent, multimedia and control tools direct.
- 8af3b86: Reject same-patch hardlink aliases and inode replacement while acquiring native
  mutation queues. Reset native-tool suppression receipts on session/tree changes,
  bind nested direct-tool visibility to the registered provider owner, reject
  duplicate owned definitions, and validate feature requirement syntax before
  discovery offers.
  
  Keep the Codex stream's effective-checkpoint contract on native fallback paths
  as well as enabled transports. Correct Telegram's package description to describe
  native blocking extension UI prompt notifications.
- 8af3b86: Use Pi 0.86.1's native interfaces: order multi-file mutation locks by canonical
  target identity, reject conflicting aliases and identity drift without an unqueued
  fallback, contribute stable Code Mode prompt sections,
  and enforce child report exclusions at registry creation. Telegram waiting
  notifications now follow native blocking-UI events for all extension dialogs,
  using their titles rather than tool-name timers or rpiv questionnaire summaries.
- Updated dependencies [8af3b86]
- Updated dependencies [8af3b86]
- Updated dependencies [8af3b86]
- Updated dependencies [8af3b86]
  - @oai404iao/pi-codex-runtime@0.3.1

## 0.3.0

### Minor Changes

- ac5c2e5: Add optional provider-neutral Code Mode grammar transport and lossless history
  projection, generic Codex Standard/Lite grammar streaming and replay, and explicitly
  granted patch/standalone-search contributions without Code Mode dependency edges.
  Preserve JSON defaults, direct tools, existing authorization and private release status.
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

## 0.2.0

### Minor Changes

- 99f497f: Add the global `webSocketEnabled` setting. It defaults to `true`; setting it to
  `false` forces Responses SSE and disables WebSocket prewarm across model
  profiles without changing their catalog values.
  
  Remove deprecated per-model compatibility keys from `config.schema.json`.
  Their one-version runtime migration remains available, but new configuration
  and editor completion now expose only supported global settings.

### Patch Changes

- Updated dependencies [99f497f]
  - @oai404iao/pi-codex-runtime@0.2.0

## 0.1.0

### Minor Changes

- fca54ca: Add an exact `openai-codex/gpt-6-astra` Responses Lite profile using the model
  descriptor supplied by the supported Pi baseline.
  
  Promote `config.json.imageGeneration` to a global generation gate. Disabling it
  now omits image tools, background commands, presentation and provider injection,
  blocks standalone/direct execution before network I/O, and leaves all unrelated
  model-profile behavior unchanged.
- fca54ca: Raise every public plugin's Pi peer floor to `>=0.85.1`. Pi 0.85.0 is excluded
  because its published SDK imports are broken; the private tree-continue
  experiment is audited for 0.85.1 too but remains blocked from publication.

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
- 952cb3f: Restrict native web-search and image-generation placeholder rewriting to
  capabilities installed in the Codex broker. Core-only installations must leave
  unowned tool names unchanged rather than turning another extension's function
  into a hosted or reserved namespace tool.
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
- Updated dependencies [fca54ca]
- Updated dependencies [fca54ca]
- Updated dependencies [952cb3f]
- Updated dependencies [952cb3f]
- Updated dependencies [952cb3f]
- Updated dependencies [32ba01f]
  - @oai404iao/pi-codex-runtime@0.1.0

## 0.1.0-alpha.1

### Patch Changes

- 952cb3f: Pin the supported-package development baseline to Pi 0.85.1 while retaining
  the Pi 0.84.2 peer floor. Add full floor/target compatibility verification,
  including independently installed Codex tarballs and real-loader checks.
  The private tree-continue hook remains exact-0.84.2 and disabled under the target
  loader. No Codex catalog, protocol, default capability or publication eligibility
  is changed.
- 952cb3f: Restrict native web-search and image-generation placeholder rewriting to
  capabilities installed in the Codex broker. Core-only installations must leave
  unowned tool names unchanged rather than turning another extension's function
  into a hosted or reserved namespace tool.
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
- Updated dependencies [952cb3f]
- Updated dependencies [952cb3f]
- Updated dependencies [952cb3f]
- Updated dependencies
  - @oai404iao/pi-codex-runtime@0.1.0-alpha.1
