# pi-codex-runtime — maintenance

Shared library, not a Pi extension. No default factory or `pi.extensions`.

## Ownership

- `src/broker.ts`: synchronous event-bus discovery, ABI/runtime-version checks,
  package claims and presentation snapshots. Do not use module identity to dedupe.
- `src/tool-activation.ts`: one session owner for installed-tool projection and
  edit/write suppression. Never suppress tools owned by uninstalled capabilities.
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
4. Schemas/default-models here are canonical. Update their checked legacy mirrors
   without changing old configuration locations. Do not infer unknown model support.
5. Preserve namespace JSON fingerprints, modification notices and license snapshots.
   Wire identity and catalog have inherited, downward-only line exceptions.

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
npm run check -w @oai404iao/pi-codex-runtime
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
