# Publication readiness audit

Audit date: 2026-08-17
Baseline commit: `fdc4ed6a3702fb226ff85b9a084e940a3122d41a`
Public cutover verified: 2026-08-18

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
| Post-cutover `main` CI | passed on Node.js 22.19 and 24 |

The repository preserved its history. The maintainer approved publication of
the historical author identity and commit metadata during the cutover, and
local `main` was verified byte-for-byte against GitHub after each push.

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
| `pi-codex-minimal-tools` | private | typecheck and 202 tests | captured tool-metadata provenance |
| `pi-keep-defaults` | publishable candidate | typecheck and smoke/guard tests | watcher lifecycle/release approval |
| `pi-subagent` | private | typecheck and 51 tests | DeepSeek Harness provenance, global preset side-effect review |
| `pi-telegram-notify` | publishable candidate | typecheck and 8 tests | privacy/internal-hook release approval |
| `pi-tree-continue` | private | typecheck and pack check; no test suite | private Pi API dependency, tests |
| `external-thinking` | no | not covered by npm workspace CI | manifest, tests, compatibility fix |

The exact six current unscoped names returned npm E404 during the phase-1
audit. E404 is not a reservation or ownership guarantee; availability must be
checked again immediately before bootstrap publishing.

## License and source review

Project-authored material now carries an MIT license with the user-confirmed
copyright `2026 oai404iao`. Each npm workspace includes a package-level
license. Third-party license texts and notices are preserved separately rather
than being relicensed under the project MIT grant.

### `external-thinking`

- README and source identify it as a port of
  [`can1357/oh-my-pi`](https://github.com/can1357/oh-my-pi).
- The upstream repository is MIT-licensed and contains named copyright
  notices.
- The feature-introduction and reference revisions, applicable upstream
  notices, and local modification scope are recorded in its
  `THIRD_PARTY_NOTICES.md`.

### `pi-codex-minimal-tools`

- Reference documents identify an analyzed OpenAI Codex revision.
- `src/providers/codex-apply-patch.lark` is described as an exact grammar
  snapshot and was verified byte-for-byte against upstream revision
  `eb9dceba1a2e658142a456c5898836774835616b`.
- `src/codex-reserved-tools.ts` contains captured tool definitions that need a
  source and redistribution review.
- OpenAI Codex is Apache-2.0. Its license and NOTICE are preserved, and the
  exact grammar source is mapped in `THIRD_PARTY_NOTICES.md`.
- The provenance and redistribution terms of service-emitted or
  server-supplied portions in `src/codex-reserved-tools.ts` remain unresolved,
  so the package is private.

Official upstream license:
[`openai/codex/LICENSE`](https://github.com/openai/codex/blob/main/LICENSE).

## Privacy and public presentation

- The sole historical author identity was accepted for the current public
  history during cutover.
- Re-record media if screenshots expose private provider names.
- Replace local installation paths with npm commands only after packages exist.
- Do not publish real Telegram `config.json`, model credentials, session files,
  or private provider endpoints.

## Remaining release gates

- [x] GitHub owner and real `oai404iao/omp` repository confirmed.
- [x] Historical identity approved for publication.
- [ ] Package-level license files and source notices reviewed.
- [ ] Final tarball contents reduced and approved.
- [ ] Package names/owners rechecked on npm.
- [ ] Initial packages created with interactive 2FA.
- [ ] npm trusted publishers configured for `publish.yml`.
- [ ] `npm-publish` environment protected and enabled.
- [ ] Release lock changed in a dedicated reviewed pull request.
