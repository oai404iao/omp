# Contributing

## Setup

Use the repository root so npm installs the locked workspace dependency graph:

```bash
npm ci --ignore-scripts
```

Do not commit per-package `package-lock.json` files. The root
`package-lock.json` is the single CI lockfile.

## Checks

Run the complete local verification before opening a pull request:

```bash
npm run ci
```

Package checks include each extension's typecheck and tests where present.
`license:check` protects verified source/license snapshots. `pack:check`
inspects the exact npm tarball file list and verifies every Pi extension entry
point and runtime asset is included.

## Changesets

Add a changeset when a pull request changes a package's behavior, public
configuration, dependencies, or published documentation:

```bash
npm run changeset
```

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
