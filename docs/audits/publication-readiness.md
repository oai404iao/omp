# Publication readiness audit

Audit date: 2026-08-17
Baseline commit: `fdc4ed6a3702fb226ff85b9a084e940a3122d41a`

This document records evidence and open questions. It is not a legal opinion
or proof that the repository contains no sensitive material.

## Git history

| Check | Result |
| --- | --- |
| Total reachable commits | 49 |
| Non-merge commits | 44 |
| Distinct author identities | 1; identity intentionally omitted here |
| `origin/main...main` | `0 3` |
| `origin/main` ancestor of `main` | yes |
| `git fsck --full` | passed |
| Largest reachable blob | 197,752 bytes |
| Full-history gitleaks default scan | no findings |
| Phase-1 current-tree gitleaks default scan | no findings |

The repository will preserve its history. Before the public push, the
maintainer must explicitly accept publication of historical author identity
and commit metadata.

The initial scan found one repository-specific absolute path in
`pi-keep-defaults/README.md`; phase 1 replaces it with an installation
placeholder. The `/home/me/...` path in the Telegram README is an intentional
generic output example.

## Dependency audit

`npm audit --omit=dev` reports zero production vulnerabilities for the
workspace lockfile. The full development graph currently reports five
high-severity findings through older Pi development/test baselines and their
transitive dependencies (`undici`, `ws`, `protobufjs`, and
`brace-expansion`).

Those packages are not bundled into the five npm tarballs as production
dependencies, so CI gates the production graph while this baseline is being
prepared. Before public release, update each plugin's tested Pi development
version and resolve or explicitly re-evaluate the full development audit.
Dependabot is configured to keep this visible; the findings must not be
silently accepted as a permanent exception.

## npm package status

| Package | Manifest | Local check | Publication blockers |
| --- | --- | --- | --- |
| `pi-codex-minimal-tools` | yes | typecheck and 202 tests passed before phase 1 | source/license audit, exact GitHub metadata |
| `pi-keep-defaults` | yes | typecheck and smoke/guard tests passed before phase 1 | package LICENSE, exact GitHub metadata |
| `pi-subagent` | yes | typecheck and 51 tests passed before phase 1 | package LICENSE, global preset side-effect review, exact GitHub metadata |
| `pi-telegram-notify` | yes | typecheck and 8 tests passed before phase 1 | package LICENSE, privacy/internal-hook review, exact GitHub metadata |
| `pi-tree-continue` | yes | packable; no test suite | private Pi API dependency, tests, package LICENSE, exact GitHub metadata |
| `external-thinking` | no | not covered by npm workspace CI | manifest, tests, compatibility fix, upstream attribution |

The exact six current unscoped names returned npm E404 during the phase-1
audit. E404 is not a reservation or ownership guarantee; availability must be
checked again immediately before bootstrap publishing.

## License and source review

All five manifests currently declare `MIT`, but the repository has no tracked
license text. Phase 1 deliberately does not invent a copyright holder or treat
the manifest field as a completed rights audit.

### `external-thinking`

- README and source identify it as a port of
  [`can1357/oh-my-pi`](https://github.com/can1357/oh-my-pi).
- The upstream repository is MIT-licensed and contains named copyright
  notices.
- Record the exact source revision, preserve applicable notices, and describe
  local modifications before creating the npm package.

### `pi-codex-minimal-tools`

- Reference documents identify an analyzed OpenAI Codex revision.
- `src/providers/codex-apply-patch.lark` is described as an exact grammar
  snapshot.
- `src/codex-reserved-tools.ts` contains captured tool definitions that need a
  source and redistribution review.
- OpenAI Codex is Apache-2.0. Map copied/adapted files to public upstream
  sources, preserve required attribution and license material, and add a
  reviewed `THIRD_PARTY_NOTICES.md` before publication.

Official upstream license:
[`openai/codex/LICENSE`](https://github.com/openai/codex/blob/main/LICENSE).

## Privacy and public presentation

- Review the sole historical author identity before pushing.
- Re-record media if screenshots expose private provider names.
- Replace local installation paths with npm commands only after packages exist.
- Do not publish real Telegram `config.json`, model credentials, session files,
  or private provider endpoints.

## Remaining release gates

- [ ] GitHub owner and real `<owner>/omp` repository confirmed.
- [ ] Historical identity approved for publication.
- [ ] Package-level license files and source notices reviewed.
- [ ] Final tarball contents reduced and approved.
- [ ] Package names/owners rechecked on npm.
- [ ] Initial packages created with interactive 2FA.
- [ ] npm trusted publishers configured for `publish.yml`.
- [ ] `npm-publish` environment protected and enabled.
- [ ] Release lock changed in a dedicated reviewed pull request.
