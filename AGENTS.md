# OMP Pi Extensions — maintenance

This is a private pnpm release workspace for TypeScript/ESM Pi extensions, not
a single application. Read [CONTRIBUTING.md](CONTRIBUTING.md) for contribution
requirements. Before editing any extension package, read its local `AGENTS.md`;
package-specific ownership and invariants are documented there.

## Environment and commands

Run commands from the repository root unless stated otherwise.

- Use Node.js >=22.19.0 and the pinned pnpm 12.4.1 (`package.json`).
- Install with `pnpm install --frozen-lockfile --ignore-scripts`.
- `pnpm-workspace.yaml` defines the seven release workspaces. The root
  `pnpm-lock.yaml` is the only project lockfile; do not add npm or per-package locks.
- `pi-extensions/pi-local-notify/` is private and outside the release workspace.
  Its checks use root-installed tooling; do not add it to publication batches.

| Task | Command |
| --- | --- |
| Check one workspace package | `pnpm --filter @oai404iao/<package> run check` |
| Check local-only notifications | `pnpm run check:local-notify` |
| Check all extensions, including local-only notifications | `pnpm run check` |
| Check Codex module/dependency boundaries | `pnpm run check:architecture` |
| Test cross-package Codex behavior | `pnpm run test:codex-composition` |
| Verify licenses and packaged files | `pnpm run license:check` and `pnpm run pack:check` |
| Test isolated Codex tarball consumers | `pnpm run test:codex-packages` |
| Test release infrastructure | `pnpm run test:release-scripts` |
| Complete verification before a PR | `pnpm run ci` |
| Additional Pi compatibility verification | `pnpm run ci:pi-matrix` |

Use affected checks during development; `ci` already includes the ordinary
architecture, package, composition, release-script and license checks.
Tarball-consumer tests install offline from the root lock and populated pnpm
store; a missing artifact is a prerequisite failure, not permission to weaken
isolation or fetch an unlocked replacement.

For Pi compatibility changes, read [docs/pi-compatibility.md](docs/pi-compatibility.md).
Also run `pnpm run ci:pi-matrix` for those changes.
The current peer floor and exact development target are both Pi 0.99.1.
The matrix snapshots tracked working-tree files: stage new source files before
running it so they are included. Its floor preparation may access the registry.
Fixture success does not establish real endpoint access or account entitlement.
Live model tests are separate from CI; do not run them without explicit authorization.

## Ownership and contracts

- `pi-codex-runtime` owns shared settings, catalog, identity, broker and replay
  contracts. It is a library, not a Pi extension.
- `pi-codex-core` owns Responses transport, compaction, patch and image viewing.
  `pi-codex-web-search` and `pi-codex-imagegen` own their respective capabilities.
  Each capability may depend on runtime, not another capability or the bundle.
- `pi-codex-minimal-tools` is pure composition plus the public
  `./subagent-inline` re-export. Do not restore a monolith or duplicate schemas,
  fixtures or implementations there.
- Behavioral tests belong with their implementation owner. Cross-capability
  integration and neutral fixtures belong in `tests/codex/`, not owner tests
  that import another capability.
- Codex source boundaries and line budgets are checked by
  `scripts/check-codex-architecture.mjs`; reviewed exceptions live in
  `scripts/codex-architecture.json`. New Codex source modules must stay within
  400 lines; reduce existing exceptions rather than enlarging them.
- Preserve the shared `extensions/pi-codex-minimal-tools/` configuration paths.
  Runtime owns the canonical schemas/catalog. Do not invent per-capability
  configuration directories or infer support for unknown model IDs.

Read [docs/codex-packages.md](docs/codex-packages.md) for composition, broker or
lifecycle changes; [docs/codex-wire-alignment.md](docs/codex-wire-alignment.md)
for wire changes; and the
[runtime reference index](pi-extensions/pi-codex-runtime/reference/README.md)
for protocol/source evidence. For subagent API or configuration changes, read
[its migration guide](pi-extensions/pi-subagent/README.md#breaking-migration);
the current API is asynchronous multi-agent v2, not the old synchronous contract.
Notification behavior and configuration are documented in each notifier's README.

## Changesets, artifacts and authorization

- Package behavior, configuration, dependency or published-documentation changes
  need `pnpm run changeset`, then `pnpm run changeset:sync`. Repository-only
  instructions, tests and infrastructure do not need a changeset unless they
  alter a published package.
- Do not hand-edit generated `.changeset/workspace-dependent-releases*.md`,
  loosen exact workspace dependency pins or manually bump package versions.
  For authorized versioning, use `pnpm run changeset:version`, not bare
  Changesets versioning; the wrapper synchronizes consumers, repairs pins and
  refreshes the root lock.
- Read [RELEASING.md](RELEASING.md) before release work. Ordinary maintenance does
  not authorize publication, workflow dispatch, release-eligibility changes or
  replacing immutable entries in `release-locks/`.
- Packages ship TypeScript source and explicit runtime assets. Preserve manifest
  `files` allowlists and keep `AGENTS.md`, tests and private configuration out of
  tarballs. Run `pack:check` when changing packaged paths or entry points.
- Preserve pinned provenance, grammar fingerprints and adaptation/license notices.
  Record exact upstream revisions for copied material; consult
  [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) and the owning package's evidence.
- Never add real Telegram configuration, provider credentials or private endpoints.
  Local edits do not authorize installing extensions or changing Pi/tmux settings.
