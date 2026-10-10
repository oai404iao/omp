# pi-codex-runtime — maintenance

Shared library, not a Pi extension. No default factory or `pi.extensions`.

## Ownership

- `src/broker.ts`: synchronous event-bus discovery, ABI/runtime-version checks,
  package claims and presentation snapshots. Do not use module identity to dedupe.
- `src/tool-activation.ts`: one session owner for package-tool activation and
  exposure. Never alter tools owned by uninstalled capabilities. Core's patch
  `prepareLoadout` hook hides selected native mutation-tool declarations without
  removing them from Pi's active set; preserve their resume and codemode access.
- `src/session-claims.ts`, `codex-identity-extension.ts`: shared identity hooks,
  including the supported `./subagent-inline` SDK integration.
- `src/model-catalog/`, `settings.ts`: exact catalog profiles and legacy paths.
- `src/providers/responses/`: neutral replay/signature/stream contracts.
- `src/reserved-tools/`: per-capability Apache-attributed namespace evidence.

## Constraints

1. No dependency on core, web-search, imagegen or the compatibility bundle,
   including optional/peer dependencies. No Responses SSE/WS, image storage or
   capability endpoint clients.
2. Broker v1 requires identical runtime versions. Shutdown closes discovery;
   actual Pi runtime invalidation disposes tracked subscriptions on reload.
3. Capture presentation sinks before I/O; observer state is response-attempt-local.
4. Schemas/default-models here are the sole copies. Preserve existing configuration
   locations; do not add bundle mirrors or infer unknown model support.
5. Preserve namespace JSON fingerprints, modification notices and license snapshots.
   Only the catalog has a reviewed, downward-only line exception in root
   `scripts/codex-architecture.json`.

## Workflow and verification

Follow [root guidance](../../AGENTS.md) for setup, compatibility checks,
Changesets and publication boundaries. For broker changes, read
[Codex composition](../../docs/codex-packages.md); for settings/catalog changes,
read [configuration](reference/configuration.md) and
[model catalog](reference/model-catalog.md). Source evidence is indexed in
[the source map](reference/source-map.md).
Keep new source modules within the 400-line budget. AGENTS/tests/reference
are not shipped; canonical schemas and default models are runtime assets.

From repository root:

```bash
pnpm --filter @oai404iao/pi-codex-runtime run check
pnpm run test:codex-composition
pnpm run check:architecture
```

Use `pnpm run test:codex-packages` for exports, assets or broker composition
changes and `pnpm run ci` for complete pre-PR verification; CI includes the
focused checks.

Behavioral regressions live in `tests/`; neutral fixtures and cross-capability
integration live in root `tests/codex/`. Runtime tests must not import core or
capability implementations, including indirectly through a shared harness.
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
