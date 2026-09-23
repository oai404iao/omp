# @oai404iao/pi-code-mode

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

- 8af3b86: Complete v2 contribution declarations, bounded consumer generations/revision
  checks, public structural unsettled-effect errors, classified/coalesced refresh,
  Codex's optional structural client and transcript-aware transport negotiation.
  Add explicit, default-off inventory and native-local ls pilots with exact grants;
  keep subagent, multimedia and control tools direct.

### Patch Changes

- 8af3b86: Complete fail-closed required-policy admission, policy readiness and legacy
  revocation gates. Close all owner controls before shutdown callbacks, retain
  cleanup retries after foreign replacements, and attempt independent cleanup and
  native mutation-tool restoration even when another receipt fails.
- 8af3b86: Gate approval-dependent Code Mode contributions from legacy consumers, retain
  retryable owner cleanup and live-control budgets, strengthen exec/wait ownership,
  and reconcile current owner intent and Codex tool suppression after tree replay.
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

## 0.2.0

### Minor Changes

- ac5c2e5: Add an independent, private S1 Code Mode package with provider-neutral JSON exec,
  explicit local-read grants, descriptor-anchored read/list tools, and mandatory
  Linux x64 systemd/cgroup resource supervision. Publication remains blocked.
- ac5c2e5: Add S2 JSON exec/wait orchestration with cross-turn cells, explicit termination,
  versioned tool/policy contributions, native usage receipts, and separately granted
  atomic writes and supervised local processes. Preserve mixed-mode tools and the
  private/blocked release status.
- ac5c2e5: Add optional provider-neutral Code Mode grammar transport and lossless history
  projection, generic Codex Standard/Lite grammar streaming and replay, and explicitly
  granted patch/standalone-search contributions without Code Mode dependency edges.
  Preserve JSON defaults, direct tools, existing authorization and private release status.
- ac5c2e5: Add opt-in cooperative hide-bridged visibility with explicit owner bindings,
  live-state restoration, dynamic registration/reload support, and visibility
  status commands. Keep mixed as the default, preserve authorization boundaries,
  and leave S3 grammar adapters and strict-only mode out of scope.
- 972d2c2: Pin the separately verified 0.155.1 Host with the upstream V8 sort workaround,
  recording its GNU/glibc requirements and build provenance. Add explicit capability
  negotiation, operation duration validation and top-level empty object argument
  normalization before owner preparation and policy validation.
- 972d2c2: Add strict user-level non-permission configuration, static/explicit Host doctor
  diagnostics, bounded TypeScript-style tool contracts and optional output schema
  metadata. Preserve explicit CLI authority and original runtime schema validation.
- 972d2c2: Retain bounded UTF-8 output on overflow, expose runtime/commit diagnostics and
  incremental timed traces, and add separate non-authoritative completion observers.
  Stream-verify a private content-addressed Host cache on every launch without
  relaxing watchdogs or unconfirmed-effect handling.
- bb7e5ea: Require Pi 0.86.1 or newer. Adapt Codex streaming and native compaction to
  transcript-backed system prompts and tool declarations, keep inherited parent
  system authority out of child sessions, and recognize in-conversation OpenAI
  tool additions in External Thinking. Preserve the existing Codex wire formats,
  model profiles and publication eligibility. Keep Code Mode's already-restored
  direct tools available after historical tool-loadout restoration.
