# @oai404iao/pi-codex-runtime

## 1.0.1

### Patch Changes

- a80379d: Preserve selected native edit/write tools when apply_patch is active. Hide their
  model-facing declarations through Pi's prepareLoadout API instead of physically
  deactivating them, so tree navigation, reload and resume retain the user's tool
  selection without in-memory restoration receipts. Keep prewarm and compaction
  snapshots aligned with the owned patch projection; explicitly disabled tools
  remain disabled.
- d250a74: Use pnpm for development scripts and document frozen-lockfile installation.

## 1.0.0

### Major Changes

- 3b07cbf: Align Codex request identity, metadata, Responses envelopes, WebSocket prewarm,
  search context/policy and image parameters with upstream revision 5a314017.
  Preserve Pi authentication and privacy boundaries without fabricating Codex
  telemetry or attestation.
  
  Remove hosted image generation, direct Images fallback and unary
  `responses-compact` execution. Explicit old configurations require migration;
  historical image outputs and opaque compaction replay remain supported.

### Minor Changes

- 7edbf75: Keep `/fast` selections in the session rather than rewriting the configured
  new-session default. Restore selections on resume/reload and branch navigation.
  Subagent requests dynamically follow the main agent's Fast selection, including
  followups and sessions with OpenAI wire identity disabled.

## 0.5.0

Final model defaults: `openai/gpt-6.1-sol` uses the GPT-5.6 Sol Lite profile
described below, superseding its initial Standard profile in this release.
The other modern GPT-6 profiles remain Standard.

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
- 719c607: Forward raw provider events before Codex SSE/WebSocket normalization and prepare
  subagent Codex identity for virtual model selections, preserving identity across
  routing changes and cold resumes without adding identity to model context.

  Align the default `openai/gpt-6.1-sol` profile with `openai/gpt-5.6-sol`: Lite,
  auto transport, prewarm, standalone web/image, custom patch, native compaction
  and priority Fast availability with a 2x cost multiplier. Keep other GPT-6 and
  legacy Codex profiles unchanged. These defaults do not establish real-account
  endpoint access or verified Fast pricing.

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

## 0.3.1

### Patch Changes

- 8af3b86: Complete fail-closed required-policy admission, policy readiness and legacy
  revocation gates. Close all owner controls before shutdown callbacks, retain
  cleanup retries after foreign replacements, and attempt independent cleanup and
  native mutation-tool restoration even when another receipt fails.
- 8af3b86: Gate approval-dependent Code Mode contributions from legacy consumers, retain
  retryable owner cleanup and live-control budgets, strengthen exec/wait ownership,
  and reconcile current owner intent and Codex tool suppression after tree replay.
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

## 0.2.0

### Minor Changes

- 99f497f: Add the global `webSocketEnabled` setting. It defaults to `true`; setting it to
  `false` forces Responses SSE and disables WebSocket prewarm across model
  profiles without changing their catalog values.
  
  Remove deprecated per-model compatibility keys from `config.schema.json`.
  Their one-version runtime migration remains available, but new configuration
  and editor completion now expose only supported global settings.

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

- 952cb3f: Pin the supported-package development baseline to Pi 0.85.1 while retaining
  the Pi 0.84.2 peer floor. Add full floor/target compatibility verification,
  including independently installed Codex tarballs and real-loader checks.
  The private tree-continue hook remains exact-0.84.2 and disabled under the target
  loader. No Codex catalog, protocol, default capability or publication eligibility
  is changed.
- 952cb3f: Apply the broker ABI, runtime-version and shape checks to cached API objects as
  well as event-bus discovery. Mixed runtime copies must fail before registering
  capabilities even when they receive the same ExtensionAPI instance.
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

## 0.1.0-alpha.1

### Patch Changes

- 952cb3f: Pin the supported-package development baseline to Pi 0.85.1 while retaining
  the Pi 0.84.2 peer floor. Add full floor/target compatibility verification,
  including independently installed Codex tarballs and real-loader checks.
  The private tree-continue hook remains exact-0.84.2 and disabled under the target
  loader. No Codex catalog, protocol, default capability or publication eligibility
  is changed.
- 952cb3f: Apply the broker ABI, runtime-version and shape checks to cached API objects as
  well as event-bus discovery. Mixed runtime copies must fail before registering
  capabilities even when they receive the same ExtensionAPI instance.
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
