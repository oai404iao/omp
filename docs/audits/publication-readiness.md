# Publication readiness audit

Audit date: 2026-08-17
Baseline commit: `fdc4ed6a3702fb226ff85b9a084e940a3122d41a`
Public cutover verified: 2026-08-18
Public npm registry checked: 2026-08-21

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

The Pi development/test baseline is 0.84.2, and the Codex package uses
`undici` 8.10.0. A fresh npm 11.19.0 lockfile reports zero vulnerabilities for
both the complete dependency graph and `--omit=dev`.

The update moves public/supported Pi peer ranges from an unconstrained wildcard
to `>=0.84.2`, so consumers do not silently combine those extensions with the
older vulnerable baselines that GitHub's dependency graph identified.
`pi-tree-continue` is the deliberate exception: its private unsupported hook
is pinned to exactly 0.84.2. Dependabot remains enabled for ongoing review.

## npm package status

| Package | Manifest | Local check | Publication blockers |
| --- | --- | --- | --- |
| `@oai404iao/pi-codex-minimal-tools` | public `1.3.0` | typecheck, full test suite, source hashes, and pack check | guarded release approval |
| `@oai404iao/pi-external-thinking` | public `0.1.0` | typecheck and 9 behavior tests | confirm trusted publisher before its next OIDC release |
| `@oai404iao/pi-keep-defaults` | public `0.1.3` | typecheck and smoke/guard tests | watcher lifecycle/release approval |
| `@oai404iao/pi-subagent` | public `0.2.0` | typecheck and 60 tests | guarded release approval |
| `@oai404iao/pi-telegram-notify` | public `0.1.3` | typecheck and 8 tests | privacy/internal-hook release approval |
| `@oai404iao/pi-tree-continue` | private | typecheck, exact-version guard, and pack check | upstream public continuation API required; private hook bypasses lifecycle/auth/prompt guarantees |

The exact six unscoped names returned npm E404 during the phase-1
audit. That result is historical only: all six workspace package manifests
now use the `@oai404iao` scope. E404 is not a reservation or ownership
guarantee; the exact scoped names must be checked again immediately before
bootstrap publishing.

When its `1.3.0` bootstrap candidate was prepared on 2026-08-21,
`@oai404iao/pi-codex-minimal-tools` returned npm E404. This was only a
point-in-time availability observation, not a reservation or ownership
guarantee. Its manual bootstrap subsequently succeeded from
`596d799c6f7db3508b6d46bb05cdca6ea9e3b716`; npm `latest`, `gitHead`, and the
published SHA-512 integrity match that reviewed source and artifact.

The two public candidate packages were observed on npm at `0.1.2`, with npm
`gitHead` `0c53bdb9e13b006a23a8da05a01c06f106fa2c10`; their package tags and
GitHub Releases match that commit. This confirms the bootstrap artifacts, not
the npm account's 2FA policy or trusted-publisher configuration.

The guarded publishing workflow subsequently released both public packages at
`0.1.3`, with npm `gitHead`
`16dccb8953b717670c34fe978c79c07d592ca7e2`, matching package tags and GitHub
Releases.

`@oai404iao/pi-external-thinking@0.1.0` was bootstrapped from
`aae803f4b25603991d9375c602cf35da1df922b0`; its npm `gitHead`, `latest`
dist-tag, package tag, and GitHub Release match that commit.

`@oai404iao/pi-subagent@0.2.0` was bootstrapped from
`ef42984c0e40ef1f26ead4b4c7d149b21280e66b`; its npm `gitHead` and `latest`
dist-tag match that commit. Its trusted publisher is configured; the guarded
workflow owns initial tag/Release reconciliation and future releases.

## License and source review

Project-authored material now carries an MIT license with the user-confirmed
copyright `2026 oai404iao`. Each npm workspace includes a package-level
license. Third-party license texts and notices are preserved separately rather
than being relicensed under the project MIT grant.

### `@oai404iao/pi-external-thinking`

- README and source identify it as a port of
  [`can1357/oh-my-pi`](https://github.com/can1357/oh-my-pi).
- The upstream repository is MIT-licensed and contains named copyright
  notices.
- The feature-introduction and reference revisions, applicable upstream
  notices, and local modification scope are recorded in its
  `THIRD_PARTY_NOTICES.md`.
- The package manifest, tarball allowlist, and behavior tests now cover the
  workspace. Its `0.1.0` bootstrap is complete; retain its trusted publisher
  for subsequent guarded OIDC releases.

### `@oai404iao/pi-codex-minimal-tools`

- Reference documents identify an analyzed OpenAI Codex revision.
- `src/providers/codex-apply-patch.lark` is described as an exact grammar
  snapshot and was verified byte-for-byte against upstream revision
  `eb9dceba1a2e658142a456c5898836774835616b`.
- `src/codex-reserved-tools.ts` is a modified TypeScript compatibility
  serialization of the pinned `web.run` and `image_gen.imagegen` namespace
  declarations. Its two descriptions are byte-for-byte mapped to upstream
  Markdown sources; its parameter declarations are mapped to the pinned Rust
  schema types and generators.
- OpenAI Codex is Apache-2.0. Its license and NOTICE are preserved, and the
  exact grammar source and namespace-tool blob hashes are mapped in
  `THIRD_PARTY_NOTICES.md` and
  `provenance/openai-codex-eb9dceba-reserved-tools.json`.
- This engineering source-attribution review is not legal advice. The public
  `1.3.0` npm artifact has `gitHead`
  `596d799c6f7db3508b6d46bb05cdca6ea9e3b716` and SHA-512 integrity
  `sha512-eEUta4JsIJldxM5w+0mAz28YUlev5IECN1kOGQrCX1rFm/xsOqHmdqArmIF94zZz8pbetFo+FPI9bohdwONvLg==`.
  Its trusted publisher is configured and its guarded release track is
  activated. Responses Lite is an internal Codex compatibility path, not a
  supported public API contract.
- The immutable `1.3.0` package README and notice retain bootstrap-stage
  wording from their source revision. This is a known documentation erratum;
  root release records are authoritative until a package-facing correction is
  made in a new version with a changeset.

Official upstream license:
[`openai/codex/LICENSE`](https://github.com/openai/codex/blob/main/LICENSE).

### `@oai404iao/pi-subagent`

- The package independently adapts high-level subagent design concepts from
  the public DeepSeek Harness documentation at revision
  `4d03472cd098dc48a630e526ca620f4f37f18a0e`.
- No DeepSeek Harness source file is included. The package-level notice
  records the implementation boundary and carries a verified MIT license
  snapshot. Its provenance manifest records immutable source/blob URLs and
  SHA-256 checksums for that document and license.
- Managed global-preset synchronization is now explicit opt-in
  (`syncBundledAgents: true`); the default reads bundled definitions without
  writing user files. Its `0.2.0` bootstrap and trusted-publisher setup are
  complete.

## Privacy and public presentation

- The sole historical author identity was accepted for the current public
  history during cutover.
- Re-record media if screenshots expose private provider names.
- Keep local installation instructions available until the scoped packages
  exist; npm examples must use the `npm:@oai404iao/<package>` form.
- Do not publish real Telegram `config.json`, model credentials, session files,
  or private provider endpoints.

## Remaining release gates

- [x] GitHub owner and real `oai404iao/omp` repository confirmed.
- [x] Historical identity approved for publication.
- [ ] Package-level license files and source notices reviewed.
- [ ] Final tarball contents reduced and approved.
- [ ] Scoped package names/owners rechecked on npm.
- [x] Initial public `0.1.2` bootstrap artifacts observed on npm, GitHub tags, and GitHub Releases.
- [ ] Confirm the npm account's 2FA and package-owner settings.
- [x] npm trusted publishers configured for `publish.yml`.
- [x] `npm-publish` environment requires approval and protected branches.
- [x] `NPM_PUBLISH_ENABLED=true` is set in the `npm-publish` environment.
- [x] Release lock changed in a dedicated reviewed pull request.
- [x] Codex namespace-tool source attribution and immutable packed provenance record reviewed.
- [ ] Merge the Codex activation PR and dispatch its guarded tag/Release reconciliation.
