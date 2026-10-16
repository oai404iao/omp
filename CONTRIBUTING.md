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

### Focused verification and timings

Every package keeps its own `check` entry point. The composition-only bundle's
check is deliberately a typecheck, not a duplicate behavior suite. Local-only
notifications stay outside the release workspace and use `check:local-notify`.

```bash
pnpm --filter @oai404iao/pi-codex-tools run check
pnpm run check:local-notify
pnpm run ci:plan --base origin/main --head HEAD --shadow
pnpm run ci:affected --base origin/main --head HEAD
pnpm run ci:release --package @oai404iao/pi-telegram-notify
pnpm run ci --concurrency 2
pnpm run test:ci
```

Revision-based plans compare immutable Git revisions, not staged/unstaged edits.
Use a package's direct check or full `ci` while developing uncommitted changes.
Plans explain every selection and full fallback; `--shadow` also reports selected
counts against the full reference. Execution prints per-task timings. Add
`--report <path>` to the executor to retain machine-readable task/command timings;
use a task-specific scratch directory outside the checkout.

The shared planner reads manifest dependency, optional, development and peer
edges. A package change selects it and recursive consumers using both the merge
base and head graphs. All Codex packages **and subagent** select the composition
and exhaustive source-consumer suites. Shared tests select their integration
group; shared infrastructure, lock/toolchain changes and unclassified paths fall
back to full coverage. Only explicitly classified repository documentation and
changeset Markdown can be policy-only. Renames consider both paths. Missing Git
history falls back to full; invalid registrations/plans fail rather than skip.
New package directories must be registered, including non-published test targets.

`ci` runs the same full policy, nine package checks and three shared suites as
the full reference, with policy first and a bounded pool afterward (default two,
configurable from one to eight). It does not invoke live model tests. Package
test workers may themselves be concurrent; increase the outer limit only after
checking memory use. `ci:release` without a package selects all eight release
workspaces, never private local notifications, and only verifies sources.

### Remote CI scope

Pull requests run the **affected plan on Node 24 / Pi target**. Repository policy
and production audit always run. Selected packages and shared suites run in
separate bounded matrices after policy succeeds. Main pushes and manual runs
select the full plan and retain Node 22.19/24 and both Pi lock roles; compatibility
regressions outside the PR scope can therefore still be detected after merge.

Canonical Node 24/target checks execute once across package/suite jobs using the
committed root lock and an isolated agent directory. Its consumer suite is always
exhaustive when selected. The other three compatibility roles retain the
baseline snapshot/lock preparation and use `OMP_CODEX_CONSUMER_MODE=smoke`:
pack all six packages and check the isolated bundle's actual SDK/loader and inline
re-export. Local `ci`, `test:codex-packages`, and `ci:pi-matrix` remain exhaustive
by default. Invalid consumer modes fail, rather than reducing coverage silently.

CI opts into `OMP_PI_REUSE_TARGET=1`. A floor role can reuse the required target
leg's behavioral tests for the **same source and Node version** only when Pi
versions, every projected workspace manifest, and the complete application lock
match. Floor lock regeneration, integrity validation, frozen installation,
resolved-SDK/CLI checks, packaging checks, and isolated consumer smoke still run.
Any difference falls back to the suite with the leg's configured consumer mode.
The final aggregate requires the complete companion target coverage. Do not
enable standalone floor reuse without that successful companion.
Local `all` with this switch runs target first and never reuses a failed target.

All four existing `Node … / Pi …` required contexts now aggregate the plan and
all required work. They fail for failed, cancelled, missing or unexpectedly
skipped matrices; an empty docs-only selection is explicitly validated. These
names do not claim extra PR compatibility coverage, and no branch-protection
change is required. Workflow-level path filters must not skip these contexts.
Main pushes additionally certify `Trusted main coverage / v1` for release reuse.

CI stores per-package/suite timing artifacts. Compare both wall time and total
runner minutes before changing sharding: small packages need not gain a new
runner as they grow. The setup action caches only the pnpm store, never mutable
`node_modules` or test outcomes.

The Release PR workflow still waits for successful trusted main CI at the exact
still-current SHA. Publication can reuse separately validated full source
coverage, but always verifies fresh policy/audit and the actual immutable release
combination; see [Releasing](RELEASING.md).

### Dependency PR refreshes

Dependabot retains monthly version discovery and existing PR limits/groups, but
automatic rebasing is disabled for npm and GitHub Actions. Review pending updates
weekly and request `@dependabot rebase` when a PR is ready to merge or strict
up-to-date checks require it. Handle urgent security updates immediately; no
security alerts, update creation, dependency checks, or audit gates are disabled.
Older open PRs can continue auto-rebasing until 30 days after creation, per the
[Dependabot rebase policy](https://docs.github.com/en/code-security/reference/supply-chain-security/dependabot-options-reference#rebase-strategy).

For a conservative rollback, select `--full` for PRs instead of the affected plan
and remove the publish source-reuse condition so its selected checks always run.
Keep the aggregates, artifact consumers and publication safety gates. Workflow
changes must update the reviewed workflow digest in `scripts/ci/trusted-main.mjs`
and its policy tests; a digest mismatch refuses reuse. The four required names
and the independent Release PR trigger need not change.

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
