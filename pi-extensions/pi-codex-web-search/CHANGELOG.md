# @oai404iao/pi-codex-web-search

## 0.3.1

### Patch Changes

- 92c0a63: Make the Codex bundle composition-only while preserving its default and
  subagent-inline exports and existing configuration paths. Remove private source
  forwards and duplicate schemas/assets; runtime owns canonical schemas and
  catalog, and core owns the grammar. Move behavioral tests, protocol references,
  preview assets and source/license documentation to their owners, with
  cross-package regression tests at repository root. Retain upstream fingerprints
  and enforce the thin bundle through architecture, license and tarball checks.
- Updated dependencies [92c0a63]
- Updated dependencies [92c0a63]
  - @oai404iao/pi-codex-runtime@0.4.1

## 0.3.0

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

## 0.2.1

### Patch Changes

- 8af3b86: Reject same-patch hardlink aliases and inode replacement while acquiring native
  mutation queues. Reset native-tool suppression receipts on session/tree changes,
  bind nested direct-tool visibility to the registered provider owner, reject
  duplicate owned definitions, and validate feature requirement syntax before
  discovery offers.
  
  Keep the Codex stream's effective-checkpoint contract on native fallback paths
  as well as enabled transports. Correct Telegram's package description to describe
  native blocking extension UI prompt notifications.
- Updated dependencies [8af3b86]
- Updated dependencies [8af3b86]
- Updated dependencies [8af3b86]
- Updated dependencies [8af3b86]
  - @oai404iao/pi-codex-runtime@0.3.1

## 0.2.0

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

## 0.1.1

### Patch Changes

- 99f497f: Update exact workspace dependency pins for the pending dependency releases.
- Updated dependencies [99f497f]
  - @oai404iao/pi-codex-runtime@0.2.0

## 0.1.0

### Minor Changes

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
