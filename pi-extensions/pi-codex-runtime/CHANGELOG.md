# @oai404iao/pi-codex-runtime

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
