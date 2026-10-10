# pi-codex-core — maintenance

Provider/transport capability. Does not install web or image generation.

## Ownership

- `src/index.ts`: core claims, patch/view-image registration and diagnostics.
- `src/extension/provider-runtime.ts`: provider/session lifecycle; optional effects.
- `src/extension/startup-prewarm.ts`: cancellation, auth waiters and generation reset.
- `src/providers/openai-codex/`: request bodies, SSE/WS, continuation, retry, usage.
- `src/adapter/compaction/`: checkpoints and remote compaction protocols.
- `src/patch/`, `src/providers/codex-apply-patch.lark`: executor and pinned grammar.

## Constraints

1. Workspace imports may target runtime only, through declared exports and exact
   dependencies. Never import legacy facades or optional capability implementations.
2. Core connects stream effects to the broker. Shared services own presentation
   hooks; do not install duplicate clear/flush handlers around the broker.
3. Socket state stays session-owned. Reset prewarm waiters even if authentication
   ignores abort; consume late promise rejections without opening old connections.
4. Preserve exact-prefix continuation, opaque compaction items, event ordering,
   output indices and signatures. HTTP fallback is not a generic retry.
5. Preserve grammar hashes and Apache adaptation notices. Core owns the sole
   grammar asset and transport/apply-patch references under `reference/`.
6. Patch `prepareLoadout` hides native edit/write declarations only for the
   request; never remove those tools from Pi's active set or saved transcript.
   Preserve codemode callable access and tree/resume behavior. `view_image`
   stays model-only so its image reaches the model directly.

## Workflow and verification

Follow [root guidance](../../AGENTS.md) for setup, compatibility checks,
Changesets and publication boundaries. For broker or lifecycle changes, read
[Codex composition](../../docs/codex-packages.md). For request/replay changes,
read [wire alignment](../../docs/codex-wire-alignment.md) and the applicable
protocol notes in `reference/`; source evidence is indexed in
[runtime's source map](../pi-codex-runtime/reference/source-map.md).
Keep new source modules within the 400-line budget; this package has no
architecture exceptions. AGENTS/tests/reference are not shipped.

From repository root:

```bash
pnpm --filter @oai404iao/pi-codex-core run check
pnpm run test:codex-composition
pnpm run check:architecture
```

Use `pnpm run test:codex-packages` for installation/asset changes and
`pnpm run ci` for complete pre-PR verification; CI includes the focused checks.

Behavioral regressions and transport harnesses live in `tests/`. Neutral fixtures
and cross-capability integration live in root `tests/codex/`. Core tests must not
import web-search/imagegen implementations; move such cases to root integration.
Tests use mocked HTTP/loopback, not real credentials. Tarball tests use frozen,
offline pnpm installs of Codex and external host archives from the root lock.
Internal pnpm symlinks must stay inside the consumer fixture, never outside it.
Restore process environment, fetch, timers and sockets when adding fixtures.

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
