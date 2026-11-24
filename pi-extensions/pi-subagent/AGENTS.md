# pi-subagent — maintenance

This package owns asynchronous, reusable agent trees for Pi. It adapts Codex
multi-agent v2 with plaintext tools; it is not a synchronous subagent runner.
Follow [root guidance](../../AGENTS.md) for setup, full verification, Changesets
and publication boundaries.

## Ownership and entry points

- `index.ts` is the published entry point; `src/index.ts` registers tools,
  session hooks, message rendering and `/subagents`.
- `src/schemas.ts` owns the seven public tool contracts; `src/tools.ts` shares
  their handlers between root and children.
- `src/coordinator.ts` owns tree identity, admission, mailboxes and lifecycle;
  `src/scheduler.ts` owns execution limits and per-agent operation serialization.
- `src/store.ts` owns durable control state. `src/providers.ts` prepares child
  sessions and history; `src/runtime.ts` creates SDK child runtimes.
- `src/tool-policy.ts` owns tool selection and ceilings; `src/agents.ts` and
  `src/config.ts` own role discovery and settings. Keep settings aligned with
  `config.schema.json`, `config.example.json` and the README.
- Behavioral tests belong in `tests/`; scripted model/runtime fixtures live in
  `tests/support/fixture.ts`.

## Async v2 contracts

- Keep root and child tool definitions identical, including the [public exposure
  contract](README.md#seven-model-facing-tools). Do not restore retired tools,
  arguments or synchronous completion responses.
- Spawn and follow-up return acceptance, not completion. Follow-up carries an
  explicit task, can override the saved execution profile, and cannot target `/root`.
- Wake only after mail is durably enqueued. Start idle `/root` via a custom
  message; resume an idle child with its saved profile. Batch arrivals without
  overlapping runs for one agent. Do not wake closing/closed targets, wake after
  controller shutdown, or wake merely from reopening existing pending mail.
- `wait_agent` observes the caller's mailbox activity without consuming bodies
  or waiting for a selected child's terminal status. Deliver attributed context
  at safe boundaries after pending tool results; a timeout does not cancel work.
- Route success/error completion to the structural parent with the same wake
  semantics, even for a mail-triggered run or peer-initiated follow-up. Interrupt
  clears current wake requests, not identity/history/mail; interrupted runs send
  no completion.
- Paths are canonical `/root/...` or caller-relative, not UUIDs or filesystem
  paths. Task names stay reserved for the tree lifetime.
- Concurrency counts active child runs across the whole tree; root is excluded
  and children waiting within a turn retain slots. Explicit spawn/idle follow-up
  fail at capacity; mail-triggered child runs wait for an available slot.
- Forked history uses the compaction-aware completed-turn projection, excluding
  active assistant/tool suffixes, parent system authority and control records.

## Persistence and lifecycle

- Delegation requires a persisted root session; do not add a `--no-session`
  fallback. Preserve the session-adjacent tree store and child JSONL layout.
- Materialize child transcripts before publishing children. Commit and sync
  control snapshots before acknowledging messages; verify transcript receipts
  on disk before mailbox ACKs. Failed writes must not advance in-memory state.
- Keep mailbox/output bounds and durable completion outboxes: parent mailbox
  overflow must not discard final output. Preserve `.pending` recovery artifacts.
- Restart marks unfinished runs interrupted without automatic replay. Idle
  runtimes unload but identity, history and mail remain available for cold resume.
  This does not guarantee exactly-once external tool side effects.
- Preserve canonical-branch visibility and independent trees on root-session
  forks. Drain old controllers on session switch, `/tree`, shutdown and reload;
  parent residency must not be required for descendants to finish.
- Descriptor and tree-store versions are separate contracts. Unsupported old
  descriptors fail explicitly; do not silently migrate or delete their traces.

## Permissions and verification

- Nested roles may narrow, never widen, inherited ordinary-tool ceilings.
  Keep collaboration controls independently available subject to depth and
  concurrency checks. Do not reactivate extension-disabled tools or eagerly
  declare callable-only/deferred tools.
- Keep explicit ceilings exact, including late MCP and resource tools. Preserve
  the SDK exclusions in `src/runtime.ts`; reject CLI patterns/modifiers in role
  lists and do not let host allowlist exemptions widen child registries.
- Preserve project trust when discovering child resources. Extension inheritance
  is opt-in; children disable codemode model calls and filter pi-subagent itself.
  Shared process/filesystem access is not an OS sandbox or isolated worktree.
- From the repository root run
  `pnpm --filter @oai404iao/pi-subagent run check` for package changes. This runs
  typechecking and local scripted-model tests, not live model requests.
- For API/config changes read [the migration guide](README.md#breaking-migration);
  for lifecycle changes read [runtime and persistence](README.md#runtime-and-persistence).
  Review `tests/contracts.test.ts` before updating its approved schema snapshot.
- For upstream adaptation consult [third-party notices](THIRD_PARTY_NOTICES.md)
  and `provenance/`; for Pi compatibility use
  [the repository compatibility guide](../../docs/pi-compatibility.md).
