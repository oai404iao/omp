# pi-codex-core — maintenance

Sole Responses engine. Does not register patch, web search or image generation.

## Ownership

- `src/index.ts`: engine claim/capability publication and diagnostics.
- `src/extension/provider-runtime.ts`: provider/session lifecycle; optional effects.
- `src/extension/startup-prewarm.ts`: cancellation, auth waiters and generation reset.
- `src/providers/openai-codex/`: request bodies, SSE/WS, continuation, retry, usage.
- `src/adapter/compaction/`: checkpoints and remote compaction protocols.
- Tools supplies owned protocol descriptors through runtime; core snapshots
  these for declaration and replay mapping without importing tool implementations.

## Constraints

1. Workspace imports may target runtime only, through declared exports and exact
   dependencies. Never import legacy facades or optional capability implementations.
2. Core connects stream effects to the broker. Shared services own presentation
   hooks; do not install duplicate clear/flush handlers around the broker.
3. Socket state stays session-owned. Reset prewarm waiters even if authentication
   ignores abort; consume late promise rejections without opening old connections.
4. Preserve exact-prefix continuation, opaque compaction items, event ordering,
   output indices and signatures. HTTP fallback is not a generic retry.
5. Preserve protocol provenance and Apache adaptation notices. Tools owns the
   sole patch grammar, executor, rendering and patch references.
6. Use runtime's ownership-checked descriptor snapshots consistently across
   ordinary, prewarm and compaction requests. Never rewrite foreign same-name tools.

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
