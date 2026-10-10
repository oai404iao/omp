# pi-codex-web-search — maintenance

Independent web_search capability, using runtime without core or imagegen.

## Ownership

- `src/index.ts`: one broker claim, tool registration and capture contribution.
- `src/tools/web-search.ts`: standalone alpha/search auth, request and result flow.
- `src/tools/web-search/schema.ts`: local tool schema and input types.
- `src/tools/web-search/{capture,activity,render}.ts`: response-local state and UI.

## Constraints

1. No core, imagegen or bundle dependency, even optional/peer. Only runtime is an
   allowed workspace dependency; use its declared exports and exact version.
2. Standalone requires an enabled catalog profile and Pi model-registry auth.
   Without core, hosted search stays inactive and explicit execution fails clearly.
3. Preserve bounded recent-input capture, citation signatures and backend error
   sentinels. Observe after continuation capture; do not modify raw wire items.
4. Unknown profiles stay native; do not guess endpoint support or model families.
5. Namespace evidence belongs to runtime's `reserved-tools/web-search.ts`.
   Do not duplicate or independently edit its pinned descriptions/fingerprints.
6. Runtime owns tool exposure: standalone search is direct/codemode-callable;
   hosted search is model-only. Preserve the output schema and structured
   results rather than relying only on rendered model-facing text.

## Workflow and verification

Follow [root guidance](../../AGENTS.md) for setup, compatibility checks,
Changesets and publication boundaries. For hosted/standalone composition, read
[Codex composition](../../docs/codex-packages.md); for search protocol or display
changes, read [streaming and rendering](reference/web-search-streaming-rendering.md).
Source evidence is indexed in
[runtime's source map](../pi-codex-runtime/reference/source-map.md).
Keep new source modules within the 400-line budget; this package has no
architecture exceptions. AGENTS/tests/reference are not shipped.

From repository root:

```bash
pnpm --filter @oai404iao/pi-codex-web-search run check
pnpm run test:codex-composition
pnpm run check:architecture
```

Use `pnpm run test:codex-packages` for standalone installation or export changes
and `pnpm run ci` for complete pre-PR verification; CI includes the focused checks.

Behavioral regressions live in `tests/`; neutral fixtures and cross-capability
integration live in root `tests/codex/`. Owner tests must not import core or
imagegen implementations; hosted transport integration belongs at root.
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
