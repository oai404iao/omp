# OMP Pi Extensions

This repository contains a collection of extensions for
[Pi](https://github.com/earendil-works/pi-mono). Its public source repository
is [`oai404iao/omp`](https://github.com/oai404iao/omp); the existing private
Gitea remote is retained as a migration backup.

> Four new Codex alpha packages are published and verified; this checkout
> activates their guarded recovery. Publication of remaining candidates is separately gated.
> Guarded publication requires an explicit `publish.yml`
> dispatch, its `publish` confirmation, and the protected `npm-publish` environment.

## Packages

All seven npm workspace packages use the `@oai404iao` scope. Scope naming does
not change the private/public eligibility below.

| Package manifest (checkout version) | Release track |
| --- | --- |
| [`@oai404iao/pi-codex-minimal-tools`](pi-extensions/pi-codex-minimal-tools/package.json) | guarded |
| [`@oai404iao/pi-subagent`](pi-extensions/pi-subagent/package.json) | guarded |
| [`@oai404iao/pi-telegram-notify`](pi-extensions/pi-telegram-notify/package.json) | guarded |
| [`@oai404iao/pi-codex-runtime`](pi-extensions/pi-codex-runtime/package.json) | guarded |
| [`@oai404iao/pi-codex-core`](pi-extensions/pi-codex-core/package.json) | guarded |
| [`@oai404iao/pi-codex-web-search`](pi-extensions/pi-codex-web-search/package.json) | guarded |
| [`@oai404iao/pi-codex-imagegen`](pi-extensions/pi-codex-imagegen/package.json) | guarded |

The scoped npm packages use independent versions. The linked manifests are the
source of truth for checkout versions, including Changesets updates; this table
does not claim those versions are published. Verified registry observations are recorded separately.
The new packages' initial `latest` aliases do not make them stable; use explicit
`@next` or exact alpha versions. Do not mix new capabilities with an old monolith.
See [Codex composition](docs/codex-packages.md) for package boundaries and
[bootstrap activation](docs/audits/codex-bootstrap-activation.md) for evidence and remaining gates.

`pi-subagent` now uses a breaking, asynchronous Codex multi-agent v2 runtime:
six plaintext tools, reusable agent trees and context-delivered mailboxes.
See its [migration guide](pi-extensions/pi-subagent/README.md#breaking-migration)
before updating old tool/configuration definitions. The current Codex tracking
baseline is `551bd409ebf03fc6ea0dcad0915368d8a493f012`; historical protocol
provenance remains pinned independently.

`external-thinking`, `pi-keep-defaults`, `pi-tree-continue`, and `pi-code-mode`
have been removed from this repository and future artifact batches. Remove any
existing installation/configuration and fully restart Pi. Historical npm
artifacts and release locks remain unchanged; this does not uninstall local
copies or change the npm registry. Native Pi codemode integration and upstream
Codex Code Mode reference material in the remaining packages are unaffected.

> **Codex 1.3.0 documentation note:** the package README and notice inside the
> immutable `1.3.0` tarball are bootstrap-stage snapshots and retain
> pre-publication wording. Do not infer current eligibility from those archived
> texts; this versioned checkout updates the package-facing documentation.

## Local development

Requirements:

- Node.js 22.19 or newer
- npm 11.5.1 or newer; the repository pins npm 11.19.0
- Pi 0.99.1 peer floor and exact development target.
  Full CI verifies both lock-validation roles.

```bash
npm ci --ignore-scripts
npm run check
npm run pack:check
npm run ci:pi-matrix
```

See [Pi compatibility](docs/pi-compatibility.md) for actual-version checks,
temporary floor installations, the read-only CI matrix and known test limits.

Test an individual extension directly:

```bash
pi -e ./pi-extensions/pi-subagent
```

## Versioning

Package-facing changes use Changesets:

```bash
npm run changeset
```

Do not edit package versions manually. See [RELEASING.md](RELEASING.md) for
the guarded release process and
[docs/plans/github-migration.md](docs/plans/github-migration.md) for the
GitHub migration plan.

## Security and publication status

- Full-history secret scanning is part of the migration audit.
- npm tarballs are inspected from their `files` allowlists in CI.
- npm publication is designed for OIDC trusted publishing, without a
  long-lived npm token.
- Project-authored material is MIT-licensed. Upstream-derived material is
  mapped in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md); unresolved
  source or compatibility gates keep the affected packages private.

See [SECURITY.md](SECURITY.md) and the
[publication readiness audit](docs/audits/publication-readiness.md).

## License

Project-authored material is available under the [MIT License](LICENSE),
copyright 2026 oai404iao. Third-party components retain their respective
terms; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) and
[`LICENSES/`](LICENSES/).
