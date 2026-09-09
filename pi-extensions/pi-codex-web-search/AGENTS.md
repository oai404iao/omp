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

## Workflow and verification

Read root CONTRIBUTING.md, RELEASING.md and docs/codex-packages.md. Source evidence
is in pi-codex-minimal-tools/reference/source-map.md.
Use the root package-lock.json; never add package locks. All new modules must be
at most 400 lines. Preserve the Pi 0.84.2 floor and exact 0.85.1 target; run
`npm run ci:pi-matrix` for compatibility changes. Do not alter release locks or private/blocked status.
Tarball-facing changes require a changeset. AGENTS/tests/reference are not shipped.
Run `npm run changeset:sync` for recursive consumers; never loosen exact workspace pins.

From repository root:

```bash
npm run check -w @oai404iao/pi-codex-web-search
npm run check -w @oai404iao/pi-codex-minimal-tools
npm run check:architecture
npm run test:codex-packages
npm run ci
```

Most behavioral regressions remain in the compatibility package's tests and
shared fixtures; the owner package's entry smoke alone is not sufficient.
Tests use mocked HTTP/loopback, not real credentials. Tarball tests npm-install
Codex and external host archives independently from the root lock, without external links.
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
