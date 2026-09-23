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
5. Preserve grammar hashes and Apache adaptation notices. Keep the legacy grammar
   mirror byte-identical; source maps remain in the compatibility package reference.

## Workflow and verification

Read root CONTRIBUTING.md, RELEASING.md and docs/codex-packages.md. Source evidence
is in pi-codex-minimal-tools/reference/source-map.md.
Use the root package-lock.json; never add package locks. All new modules must be
at most 400 lines. Preserve the Pi 0.86.1 floor and exact 0.86.1 target; run
`npm run ci:pi-matrix` for compatibility changes. Do not alter release locks or private/blocked status.
Tarball-facing changes require a changeset. AGENTS/tests/reference are not shipped.
Run `npm run changeset:sync` for recursive consumers; never loosen exact workspace pins.

From repository root:

```bash
npm run check -w @oai404iao/pi-codex-core
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
