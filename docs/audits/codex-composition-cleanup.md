# Codex composition-package cleanup

Scope: relocate maintenance resources to their implementation owners and retain
`@oai404iao/pi-codex-minimal-tools` as a pure composition package. This is not a
transport redesign, model-quality experiment or npm publication.

## Inventory and final ownership

| Resource | Owner |
| --- | --- |
| Settings/catalog/identity/replay tests; schemas; default catalog | `pi-codex-runtime` |
| Responses SSE/WS, compaction, patch/view-image tests and transport fixtures | `pi-codex-core` |
| Search client/activity/renderer tests and search protocol reference | `pi-codex-web-search` |
| Image client/capture/display/background tests and example GIF | `pi-codex-imagegen` |
| Activation, composition, cross-capability presentation/transport tests | root `tests/codex/` |
| Shared neutral test fixtures | root `tests/codex/support/` |
| Responses Standard/Lite and apply-patch references; grammar; patch example | `pi-codex-core` |
| Shared configuration, model/replay references and source-map index | `pi-codex-runtime/reference/` |
| Apache license/NOTICE and relevant immutable provenance | each actual owner |

Duplicate schemas, catalog, grammar and provenance were byte-compared with their
owners before removal. Upstream hashes, namespace fingerprints and historical
provenance contents remain unchanged. Original source notices and the historical
path-migration table are retained under runtime's `reference/`.

The bundle's former 94-file source tree is gone. Its composition and public inline
re-export now live at the package root. No private provider shim remains; the
old transport/presentation adapter is test-only in root integration fixtures.
Owner tests import actual implementations, not the bundle.

The tarball now contains exactly six files: `index.ts`, `subagent-inline.ts`,
`package.json`, `README.md`, `LICENSE`, `THIRD_PARTY_NOTICES.md` (6,958 unpacked
bytes at verification). The source directory additionally retains `AGENTS.md`,
`CHANGELOG.md` and `tsconfig.json`.

Package name, default factory, public `./subagent-inline`, configuration paths,
tool behavior and exact owner dependencies are preserved. New schema references
use runtime; published version-pinned bundle schema artifacts are unchanged.
Private `src/*` forwards and unversioned bundle asset locations are not retained.

## Verification

- Owner tests: runtime **84**, core **199**, web-search **8**, imagegen **33**.
- Root composition/integration tests: **85**. Total Codex regressions: **409**.
  Two obsolete private-facade tests were replaced by public exports, thin-bundle
  layout and transitive owner-test isolation checks; behavioral cases are retained.
- `npm run ci`: passed, including architecture, changeset coverage, workspace
  checks, composition tests, release-script tests, license/pack checks and isolated
  tarball installations through Pi's loader.
- `npm run ci:pi-matrix`: complete CI passed for Pi **0.87.0** and **0.87.1**.
- `npm run test:codex-ablation`: **25/25** offline fixtures passed.
- Independent read-only migration review: no actionable findings.

No live model requests, push or publication were performed. Release locks,
eligibility, package versions and Pi baselines were not changed.
