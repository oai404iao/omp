# pi-codex-imagegen — maintenance

Independent image capability, using runtime without core or web-search.

## Ownership

- `src/index.ts`: one broker claim, image tool, background commands, presentation.
- `src/tools/image-generation.ts`: standalone Images API auth, requests and results.
- `src/tools/image-generation/{capture,display,storage,preview}.ts`: saved images,
  generation-bound sinks, queues/timers and rendering.
- `src/utils/images.ts`: image paths, formats and persistence; no core import.
- `src/background-image-generation.ts`: cancellable background job ownership.
- `src/background-image-jobs.ts`: instance-owned status, timers and abort generations.

## Constraints

1. Only runtime is an allowed workspace dependency, with an exact version.
   Never import a core dynamic-import helper merely to load node:fs/promises.
2. Generation is standalone-only, using an enabled catalog profile and Pi
   model-registry auth/resolved endpoint. Hosted mode and directImageApiFallback
   were removed; legacy `directImageApiFallback: true` disables generation until
   that setting is removed.
   Do not select an alternate account, endpoint or implementation implicitly.
3. Acquire a display sink before request I/O. Clear cancels flush timers and
   invalidates sinks, but does not cancel/roll back file writes already underway.
4. Abort suppresses new persistence and completion notifications. Keep persistence
   best-effort so failures never discard provider replay. Shutdown cancels jobs.
5. Preserve saved message types, output paths and FIFO flush/triggerTurn behavior.
   Background job modules follow the ordinary 400-line source budget.

## Workflow and verification

Follow [root guidance](../../AGENTS.md) for setup, compatibility checks,
Changesets and publication boundaries. For broker/presentation changes, read
[Codex composition](../../docs/codex-packages.md); for generation settings and
migration, read [runtime configuration](../pi-codex-runtime/reference/configuration.md).
Source evidence is indexed in
[runtime's source map](../pi-codex-runtime/reference/source-map.md).
Keep new source modules within the 400-line budget; this package has no
architecture exceptions. AGENTS/tests/reference are not shipped.

From repository root:

```bash
pnpm --filter @oai404iao/pi-codex-imagegen run check
pnpm run test:codex-composition
pnpm run check:architecture
```

Use `pnpm run test:codex-packages` for standalone installation or asset changes
and `pnpm run ci` for complete pre-PR verification; CI includes the focused checks.

Behavioral regressions live in `tests/`; neutral fixtures and cross-capability
integration live in root `tests/codex/`. Owner tests must not import core or
web-search implementations; cross-capability transport integration belongs at root.
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
