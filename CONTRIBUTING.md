# Contributing

## Setup

Use Node.js 22.19 or newer and the pinned pnpm 12.4.1. Run from the repository
root so pnpm installs the locked workspace dependency graph:

```bash
pnpm install --frozen-lockfile --ignore-scripts
```

The root `pnpm-lock.yaml` is the single CI lockfile; `pnpm-workspace.yaml`
defines the workspace. Do not add npm or per-package lockfiles.

## Checks

Run the complete local verification before opening a pull request:

```bash
pnpm run ci
```

For Pi compatibility work also run `pnpm run ci:pi-matrix`. It runs complete CI
through the floor and target roles (both Pi 0.99.1) without modifying
the working tree. Stage new source files so they enter its tracked-file snapshot.
See [Pi compatibility](docs/pi-compatibility.md) for logs and test limitations.

Package checks include each extension's typecheck and tests where present.
`license:check` protects verified source/license snapshots. `pack:check`
inspects the exact npm tarball file list and verifies every Pi extension entry
point and runtime asset is included.

`check:architecture` checks Codex local module edges (including type imports),
compatibility-facade back-edges, direct/transitive layer restrictions, and
400-line source budgets. The provider runtime must not reach tool implementations
or local image/theme utilities through an intermediary module.
Existing oversized modules have reviewed ceilings in
`scripts/codex-architecture.json`; reduce/remove exceptions rather than growing
them. The dev-only `typescript-ast` alias provides the TypeScript 5.9 compiler
API for syntax parsing, without replacing the workspace TypeScript 7 compiler.

## Changesets

Add a changeset when a pull request changes a package's behavior, public
configuration, dependencies, or published documentation:

```bash
pnpm run changeset
pnpm run changeset:sync
```

`changeset:sync` maintains `.changeset/workspace-dependent-releases*.md` for
recursive consumers of changed workspace dependencies, including optional
dependencies. Existing explicit consumer changesets take precedence; do not edit
the generated files by hand. Prerelease iterations use distinct IDs to preserve
consumed history in `.changeset/pre/`. `changeset:check` verifies coverage and exact pins in CI.
`changeset:version` runs this synchronization, Changesets, exact-pin repair with
consumer-bump validation, and root-lock refresh. Do not invoke bare Changesets
versioning in the release workflow.

`test:codex-packages` uses
`pnpm install --offline --prod --frozen-lockfile --trust-lockfile --ignore-scripts` against a
projected root lock: Codex packages come from local tarballs, external
dependencies from locked registry artifacts. pnpm's internal symlinks are
allowed only when they resolve inside the consumer fixture; none may resolve
back to the checkout or elsewhere outside it. It runs each consumer's Pi loader.
Run `pnpm install --frozen-lockfile --ignore-scripts` first to populate the pnpm
store. The offline checks reuse that store and fail if a required artifact is
missing; they do not silently fetch it from the registry.
The fixture-only `--trust-lockfile` skips pnpm's registry-metadata policy
recheck, not frozen-lockfile or artifact integrity verification.

Infrastructure-only, test-only, and repository documentation changes do not
need a changeset unless they alter a published package.

Before a package's one-time npm bootstrap, release-preparation metadata may be
completed without bumping its still-unpublished initial version. After the
first publish, every tarball-facing change requires a changeset.

## Pull requests

- Keep plugin behavior changes separate from release-infrastructure changes.
- Do not add credentials, real Telegram configuration, provider tokens, or
  private endpoints.
- Document intentional use of Pi internal APIs and the tested Pi version.
- Record copied or adapted upstream material, including the exact source
  revision and applicable license.
- Do not enable `.github/workflows/publish.yml` in an unrelated change.
