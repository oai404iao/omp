# pi-codex-minimal-tools — maintenance

Model-profiled Pi Responses extension. Read `README.md` for user configuration,
`reference/README.md` and `reference/source-map.md` before changing wire behavior.

## Layout and ownership

- `src/index.ts`: compatible composition of the three capability factories.
- `src/extension/register.ts`: legacy composition of provider runtime and presentation.
- Other old source paths are now compatibility forwards. Follow
  `scripts/codex-source-owners.json` to the implementation owner; do not add code here.
- Core's `src/extension/provider-runtime.ts`: provider/identity/session registration with
  optional presentation injection; no direct or transitive tool implementations.
- Core's `src/extension/startup-prewarm.ts`: generation-scoped prewarm tasks; reset
  releases prewarm waiters, invalidates late authentication results and aborts
  speculative requests. The auth API itself may not cooperate with cancellation.
- Core's `src/providers/openai-codex/`: transport, request headers/body, WS cache,
  continuation, prewarm, retry, capture, and usage.
- Runtime's `src/providers/responses/`: replay items/signatures/history, stream state,
  citation rendering, and usage. It must not depend on Codex transport or tools.
- Core's `src/adapter/compaction/`: native checkpoint and remote request protocols.
- Imagegen/web-search's `src/tools/`: persistence/preview, display lifecycle
  and response-local observers. Transport must not import these modules.
- Runtime's `src/providers/openai-codex/stream-effects.ts`: internal observer contract;
  no presentation effects are installed by the transport itself.
- Runtime's `src/model-catalog/`: validated profiles; unknown models remain native.
- Runtime's `src/codex-wire-identity.ts`: shared identity; `src/subagent-inline.ts`
  remains the supported npm integration subpath.
- `tests/support/`: provider harness and loopback WebSocket server/codec.
- `provenance/`: immutable upstream fingerprints, checked by root license scripts.

## Commands (repository root)

```bash
npm ci --ignore-scripts
npm run check -w @oai404iao/pi-codex-minimal-tools
npm run check:architecture
npm run test:codex-packages
npm run ci
```

Use the root lockfile; no package lockfiles. Tests use mocked fetch or loopback
servers and do not require real Codex credentials. Transport tests must close
sockets, restore environment/fetch/timers, and reset identity state.

## Constraints

1. `provider-shim.ts` and `providers/openai-responses-shared.ts` are compatibility
   facades. Internal code imports owners directly; do not add new facade exports.
2. Keep socket caches single-instance and cleanup session-scoped. Continuation
   requires exact prefix equivalence; HTTP fallback is not a generic error retry.
3. Preserve event ordering, text signatures, native output indices, and opaque
   compaction items. Run replay, WS, identity and null-content tests after changes.
4. New source modules have a 400-line budget. Existing exceptions are explicit
   in `scripts/codex-architecture.json`; do not hide growth in another god file.
5. Reserved tool descriptions/schemas and the patch grammar have provenance and
   license checks. Moving an asset requires updating notices and pack validation.
6. Keep changesets for tarball-facing edits. Do not change publish eligibility,
   release locks, Pi baseline, or default tool behavior in a mechanical refactor.
7. `AGENTS.md`, tests and `reference/` are maintenance-only, excluded from tarballs.
   The staged package-split design lives in root `docs/plans/codex-boundaries.md`;
   new packages are locally installable private/blocked tarballs, not npm releases.
   See `docs/codex-packages.md` for broker ABI/version restrictions and test limits.
8. Capture image display ownership before starting request I/O. Clearing the
   display invalidates old sinks and cancels pending flush timers; a late result
   must not appear in the replacement session. Already-started file writes are
   not cancellable; abort suppresses new persistence and completion notifications.
9. Observers see normalized events after continuation capture, before replay
   parsing. Allocate their state per response attempt, await observation, and
   leave wire items untouched. Swallow only explicitly best-effort failures.

## Code Comments Rules (Strict)

- Prefer self-explanatory code through clear naming and structure. Comments are secondary.
- ONLY add or update comments when the logic is **not self-evident**.
- Comment these things (and only these):
  - Non-obvious intent and design decisions (the "why")
  - Important constraints, invariants, ordering requirements, and error modes
  - Interface/usage contracts that prevent plausible misuse
  - Business rules or domain constraints that cannot be expressed in code alone
  - Non-obvious edge cases or workarounds (with brief reason)
- Do NOT:
  - Restate what the code obviously does
  - Add comments to code you did not change
  - Write play-by-play, change history, ticket numbers, or "TODO/FIXME" status notes
  - Invent undocumented behavior or constraints
  - Repeat the same fact across callers and implementations (keep each fact at its owning interface)
  - Leave tombstones, removed-code explanations, or boilerplate
- Keep comments short, precise, and up-to-date. Outdated comments are worse than no comments.
- When in doubt, write clearer code instead of a longer comment.
