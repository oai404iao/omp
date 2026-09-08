# pi-codex-imagegen — maintenance

Independent image capability, using runtime without core or web-search.

## Ownership

- `src/index.ts`: one broker claim, image tool, background commands, presentation.
- `src/tools/image-generation.ts`: standalone/hosted selection and explicit fallback.
- `src/tools/image-generation/{capture,display,storage,preview}.ts`: saved images,
  generation-bound sinks, queues/timers and rendering.
- `src/utils/images.ts`: direct image API and image utilities; no core import.
- `src/background-image-generation.ts`: cancellable background job ownership.

## Constraints

1. Only runtime is an allowed workspace dependency, with an exact version.
   Never import a core dynamic-import helper merely to load node:fs/promises.
2. Standalone uses the catalog and Pi auth. Hosted mode requires core unless the
   existing directImageApiFallback option is explicitly enabled; no implicit fallback.
3. Acquire a display sink before request I/O. Clear cancels flush timers and
   invalidates sinks, but does not cancel/roll back file writes already underway.
4. Abort suppresses new persistence and completion notifications. Keep persistence
   best-effort so failures never discard provider replay. Shutdown cancels jobs.
5. Preserve saved message types, output paths and FIFO flush/triggerTurn behavior.
   Background jobs have an inherited downward-only line budget.

## Workflow and verification

Read root CONTRIBUTING.md, RELEASING.md and docs/codex-packages.md. Source evidence
is in pi-codex-minimal-tools/reference/source-map.md.
Use the root package-lock.json; never add package locks. All new modules must be
at most 400 lines. Do not change Pi 0.84.2, release locks or private/blocked status.
Tarball-facing changes require a changeset. AGENTS/tests/reference are not shipped.
Run `npm run changeset:sync` for recursive consumers; never loosen exact workspace pins.

From repository root:

```bash
npm run check -w @oai404iao/pi-codex-imagegen
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
