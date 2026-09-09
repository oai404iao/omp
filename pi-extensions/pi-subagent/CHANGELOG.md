# @oai404iao/pi-subagent

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
