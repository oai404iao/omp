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
through the floor and target roles (both Pi 1.2.0) without modifying
the working tree. Stage new source files so they enter its tracked-file snapshot.
See [Pi compatibility](docs/pi-compatibility.md) for logs and test limitations.

Package checks include each extension's typecheck and tests where present.
`license:check` protects verified source/license snapshots. `pack:check`
inspects the exact npm tarball file list and verifies every Pi extension entry
point and runtime asset is included.

### Remote CI scope

Pull requests run the full suite on **Node 24 / Pi target**. The other three
existing required matrix contexts report an explicit scope skip; they are not
claims of pre-merge compatibility testing. No branch-protection change is needed.
Pushes to `main` and manual CI runs retain both Node versions and both Pi lock
roles, so additional compatibility regressions may be detected only after merge.

The Node 24/target leg runs the exhaustive tarball-consumer matrix. Other legs
use `OMP_CODEX_CONSUMER_MODE=smoke`: pack all six packages, install the bundle
offline in an isolated consumer, and check its actual SDK/loader and inline
re-export. Their package and composition tests are otherwise unchanged.
Local `pnpm run ci`, `test:codex-packages`, and `ci:pi-matrix` remain exhaustive
by default. Invalid consumer modes fail rather than silently reducing coverage.

CI opts into `OMP_PI_REUSE_TARGET=1`. A floor role can reuse the required target
leg's behavioral tests for the **same source and Node version** only when Pi
versions, every projected workspace manifest, and the complete application lock
match. Floor lock regeneration, integrity validation, frozen installation,
resolved-SDK/CLI checks, packaging checks, and isolated consumer smoke still run.
Any difference falls back to the suite with the leg's configured consumer mode.
Do not enable standalone floor reuse without requiring the companion target.
Local `all` with this switch runs target first and never reuses a failed target.

Cheap changeset, package, license and architecture checks precede runtime tests,
so package-policy failures do not first run the expensive suites. The Release PR
workflow waits for successful trusted `main` CI at the exact still-current SHA
instead of rerunning it; see [Releasing](RELEASING.md).

### Dependency PR refreshes

Dependabot retains monthly version discovery and existing PR limits/groups, but
automatic rebasing is disabled for npm and GitHub Actions. Review pending updates
weekly and request `@dependabot rebase` when a PR is ready to merge or strict
up-to-date checks require it. Handle urgent security updates immediately; no
security alerts, update creation, dependency checks, or audit gates are disabled.
Older open PRs can continue auto-rebasing until 30 days after creation, per the
[Dependabot rebase policy](https://docs.github.com/en/code-security/reference/supply-chain-security/dependabot-options-reference#rebase-strategy).

To roll back the reduced coverage policy, revert the CI scope/consumer/reuse
settings together; the four required check names have not changed. Reverting
the Release PR trigger restores its original independent verification job.

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
