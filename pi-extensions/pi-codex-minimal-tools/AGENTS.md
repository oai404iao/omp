# pi-codex-minimal-tools — maintenance

Pure composition package. Read `README.md` and root `docs/codex-packages.md`.
Wire behavior and its references belong to the implementation owners, not here.

## Layout and ownership

- `index.ts`: composition of the three capability factories.
- `subagent-inline.ts`: supported public re-export of runtime's identity-only API.
- No `src/`, tests, schemas, assets, provenance or protocol references here.
- Runtime owns configuration/schema/catalog/replay; core owns transport/patch;
  web-search and imagegen own their clients/presentation.
- Owner tests live in their package's `tests/`; cross-package tests and neutral
  fixtures live in root `tests/codex/`.
- The reference index and source map are in `pi-codex-runtime/reference/`.

## Commands (repository root)

```bash
npm ci --ignore-scripts
npm run check -w @oai404iao/pi-codex-minimal-tools
npm run test:codex-composition
npm run check:architecture
npm run test:codex-packages
npm run ci
```

Use the root lockfile; no package lockfiles. Tests use mocked fetch or loopback
servers and do not require real Codex credentials. Transport tests must close
sockets, restore environment/fetch/timers, and reset identity state.

## Constraints

1. Preserve the public default and `./subagent-inline` exports. Do not rebuild
   private compatibility facades or duplicate owner resources.
2. Keep four exact owner dependencies; the broker deduplicates compatible
   installations. Factory order and lifecycle changes need composition tests.
3. Existing configuration paths retain the `pi-codex-minimal-tools` directory name.
4. Tarballs have an explicit six-file allowlist checked by root pack validation.
   Keep maintenance documents out of published artifacts.
5. Tarball-facing edits require changesets and `npm run changeset:sync`.
   Do not alter release eligibility, locks, Pi baselines or default tool behavior
   during mechanical cleanup.

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
