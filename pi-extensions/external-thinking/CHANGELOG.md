# @oai404iao/pi-external-thinking

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

## 0.3.0

### Minor Changes

- bb7e5ea: Require Pi 0.86.1 or newer. Adapt Codex streaming and native compaction to
  transcript-backed system prompts and tool declarations, keep inherited parent
  system authority out of child sessions, and recognize in-conversation OpenAI
  tool additions in External Thinking. Preserve the existing Codex wire formats,
  model profiles and publication eligibility. Keep Code Mode's already-restored
  direct tools available after historical tool-loadout restoration.

## 0.2.0

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

## 0.1.1-alpha.0

### Patch Changes

- 952cb3f: Pin the supported-package development baseline to Pi 0.85.1 while retaining
  the Pi 0.84.2 peer floor. Add full floor/target compatibility verification,
  including independently installed Codex tarballs and real-loader checks.
  The private tree-continue hook remains exact-0.84.2 and disabled under the target
  loader. No Codex catalog, protocol, default capability or publication eligibility
  is changed.
