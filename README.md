# OMP Pi Extensions

This repository contains a collection of extensions for
[Pi](https://github.com/earendil-works/pi-mono). Its public source repository
is [`oai404iao/omp`](https://github.com/oai404iao/omp); the existing private
Gitea remote is retained as a migration backup.

> npm publication is not enabled yet. The committed publish workflow contains
> a hard safety lock until repository ownership, package metadata, licensing,
> and npm trusted publishers have been reviewed.

## Packages

| Package | Version | Release track |
| --- | ---: | --- |
| `pi-codex-minimal-tools` | `1.3.0` | private; blocked pending third-party source review |
| `pi-keep-defaults` | `0.1.0` | candidate |
| `pi-subagent` | `0.2.0` | private; beta candidate after provenance review |
| `pi-telegram-notify` | `0.1.0` | candidate |
| `pi-tree-continue` | `0.1.0` | private; experimental |
| `external-thinking` | unpublished | incubating; attribution complete, packaging/tests pending |

The five npm packages use independent versions. `external-thinking` remains
outside the workspace until it has an audited manifest, tests, and
compatibility handling; its upstream attribution is recorded.

## Local development

Requirements:

- Node.js 22.19 or newer
- npm 11.5.1 or newer; the repository pins npm 11.19.0
- Pi 0.84.2 or newer for extension peer compatibility; CI tests against
  `@earendil-works/*` 0.84.2

```bash
npm ci --ignore-scripts
npm run check
npm run pack:check
```

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
  provenance keeps the affected packages private.

See [SECURITY.md](SECURITY.md) and the
[publication readiness audit](docs/audits/publication-readiness.md).

## License

Project-authored material is available under the [MIT License](LICENSE),
copyright 2026 oai404iao. Third-party components retain their respective
terms; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) and
[`LICENSES/`](LICENSES/).
