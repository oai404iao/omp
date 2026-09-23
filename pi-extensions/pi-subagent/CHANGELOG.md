# @oai404iao/pi-subagent

## 0.5.1

### Patch Changes

- 8af3b86: Use Pi 0.86.1's native interfaces: order multi-file mutation locks by canonical
  target identity, reject conflicting aliases and identity drift without an unqueued
  fallback, contribute stable Code Mode prompt sections,
  and enforce child report exclusions at registry creation. Telegram waiting
  notifications now follow native blocking-UI events for all extension dialogs,
  using their titles rather than tool-name timers or rpiv questionnaire summaries.

## 0.5.0

### Minor Changes

- bb7e5ea: Require Pi 0.86.1 or newer. Adapt Codex streaming and native compaction to
  transcript-backed system prompts and tool declarations, keep inherited parent
  system authority out of child sessions, and recognize in-conversation OpenAI
  tool additions in External Thinking. Preserve the existing Codex wire formats,
  model profiles and publication eligibility. Keep Code Mode's already-restored
  direct tools available after historical tool-loadout restoration.

## 0.4.1

### Patch Changes

- 99f497f: Update exact workspace dependency pins for the pending dependency releases.

## 0.4.0

### Minor Changes

- 735fcd5: Finish the move to a single durable mailbox protocol and one scheduling mode.
  
  `reportDelivery` and the parent-wakeup path are gone: a child `report` is
  recorded in the parent session and never starts or queues a parent turn, so
  nothing in this package wakes a parent turn any more. `wait_agent` is the only
  way to observe completions. The protocol is no longer versioned — tool details,
  descriptions and documentation now say `mailbox` instead of `mailbox-v2`.
  
  Compatibility layers were removed with it: descriptors must be version 4, so
  sessions written by earlier releases become a corrupt diagnostic instead of a
  resumable child, and the retired settings (`enableRunInBackground`,
  `defaultBackground`, `backgroundProtocol`, `syncBundledAgents`,
  `reportDelivery`) are rejected as unknown instead of being migrated.
  Configuration files are never rewritten; see the migration table in the
  package README. `runtimeMode` remains the single scheduling switch.
- fca54ca: Raise every public plugin's Pi peer floor to `>=0.85.1`. Pi 0.85.0 is excluded
  because its published SDK imports are broken; the private tree-continue
  experiment is audited for 0.85.1 too but remains blocked from publication.
- 952cb3f: Make bundled agent presets initialization-only. Templates are copied to the
  user agent directory on first startup and package-version changes, while
  runtime discovery now uses only user and trusted project definitions.
  Same-version user deletions remain authoritative, so deleting every role leaves
  no available subagents.
- 952cb3f: Bound continuable subagent execution with a configurable background-run limit,
  serialize same-agent cold-resume operations, expose stable turn ids with paired
  turn lifecycle events, and separate internal agent turn, residency, and
  lifecycle state.
- 952cb3f: Add quiet durable mailbox-v2 completion updates and the event-driven
  `wait_agent` tool, including restart-safe delivery reservations, timeout and
  abort cleanup, and separate unread-update observability.
- 952cb3f: Add immutable readable task paths with relative control addressing, explicit
  fresh/all-completed/last-N context inheritance, continuable fork children, and
  an optional default-off idle runtime LRU.
- 952cb3f: Add the opt-in `mailbox-v2` background protocol with durable FIFO messages,
  enqueue-only `send_message`, explicit `followup_task` scheduling, recoverable
  claims, and pending-message observability while preserving legacy defaults.

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
- 952cb3f: Clarify that mailbox FIFO follows serialized durable append order after target
  resolution, not invocation order among concurrent sends. Replace a flaky test's
  invocation-order assumption with controlled lookup-order regression coverage.
  Runtime behavior, configuration and protocol are unchanged.
- 952cb3f: Keep the wait_agent deadline timer referenced while its result is awaited.
  Headless SDK processes must not exit before the timeout resolves. Wake, abort,
  shutdown and disposal still release the timer and abort listener.

## 0.4.0-alpha.0

### Minor Changes

- 952cb3f: Make bundled agent presets initialization-only. Templates are copied to the
  user agent directory on first startup and package-version changes, while
  runtime discovery now uses only user and trusted project definitions.
  Same-version user deletions remain authoritative, so deleting every role leaves
  no available subagents.
- 952cb3f: Bound continuable subagent execution with a configurable background-run limit,
  serialize same-agent cold-resume operations, expose stable turn ids with paired
  turn lifecycle events, and separate internal agent turn, residency, and
  lifecycle state.
- 952cb3f: Add quiet durable mailbox-v2 completion updates and the event-driven
  `wait_agent` tool, including restart-safe delivery reservations, timeout and
  abort cleanup, and separate unread-update observability.
- 952cb3f: Add immutable readable task paths with relative control addressing, explicit
  fresh/all-completed/last-N context inheritance, continuable fork children, and
  an optional default-off idle runtime LRU.
- 952cb3f: Add the opt-in `mailbox-v2` background protocol with durable FIFO messages,
  enqueue-only `send_message`, explicit `followup_task` scheduling, recoverable
  claims, and pending-message observability while preserving legacy defaults.

### Patch Changes

- 952cb3f: Pin the supported-package development baseline to Pi 0.85.1 while retaining
  the Pi 0.84.2 peer floor. Add full floor/target compatibility verification,
  including independently installed Codex tarballs and real-loader checks.
  The private tree-continue hook remains exact-0.84.2 and disabled under the target
  loader. No Codex catalog, protocol, default capability or publication eligibility
  is changed.
- 952cb3f: Clarify that mailbox FIFO follows serialized durable append order after target
  resolution, not invocation order among concurrent sends. Replace a flaky test's
  invocation-order assumption with controlled lookup-order regression coverage.
  Runtime behavior, configuration and protocol are unchanged.
- 952cb3f: Keep the wait_agent deadline timer referenced while its result is awaited.
  Headless SDK processes must not exit before the timeout resolves. Wake, abort,
  shutdown and disposal still release the timer and abort listener.

## 0.3.0

### Minor Changes

- c753cd9: Add Codex-owned session, thread, turn, and request identity lifecycle support,
  plus opt-in inline OpenAI Responses identity propagation for subagents.
