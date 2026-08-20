# Releasing

## Current state

Guarded npm publication is enabled:

```yaml
RELEASE_INFRASTRUCTURE_ENABLED: "true"
```

in `.github/workflows/publish.yml`. The workflow remains manually dispatched:
it requires the exact `publish` confirmation and approval of the protected
`npm-publish` environment.

The initial public releases already exist:

- `@oai404iao/pi-keep-defaults@0.1.2`
- `@oai404iao/pi-telegram-notify@0.1.2`

Their npm `gitHead`, package tags, and GitHub Releases point to
`0c53bdb9e13b006a23a8da05a01c06f106fa2c10`. The guarded workflow for future
releases is enabled; the trusted-publisher and protected-environment gates
below still apply.

The current stable version of both packages is `0.1.3`, published from
`16dccb8953b717670c34fe978c79c07d592ca7e2`.

## One-time GitHub preparation

1. Use the public `oai404iao/omp` repository, which was created without an
   initial README or license commit.
2. Preserve the existing Gitea remote and add GitHub as a separate remote.
3. Complete `docs/audits/publication-readiness.md`.
4. Add exact repository metadata to every npm package:

   ```json
   {
     "repository": {
       "type": "git",
       "url": "git+https://github.com/oai404iao/omp.git",
       "directory": "pi-extensions/<package>"
     },
     "homepage": "https://github.com/oai404iao/omp/tree/main/pi-extensions/<package>#readme",
     "bugs": {
       "url": "https://github.com/oai404iao/omp/issues"
     }
   }
   ```

5. Keep reviewed package-level license files and all required third-party
   notices in every tarball. Do not infer ownership from a manifest field
   alone.
6. Protect `main`: require pull requests and CI, block force pushes and branch
   deletion, and require review for workflow changes.
7. Allow GitHub Actions to create release pull requests. PRs created with
   `GITHUB_TOKEN` may require a maintainer to approve their CI run.

## npm bootstrap and trusted publishing

All workspace package manifests use the `@oai404iao` npm scope. Scope naming
does not override each package's `private` flag or release eligibility.

An npm trusted publisher can only be attached after a package exists. Configure
it now for both initial public packages. For each additional new scoped package:

1. Recheck package-name availability and ownership.
2. Perform the one-time initial publish interactively with 2FA from the exact
   reviewed `main` commit. That commit must remain in the public history. Do
   not store a bootstrap token in GitHub.
3. Configure the package's GitHub Actions trusted publisher with:
   - repository: `oai404iao/omp`
   - workflow: `publish.yml`
   - environment: `npm-publish`
   - allowed action: `npm publish`
4. Configure the GitHub `npm-publish` environment:
   - required maintainer reviewer;
   - deployment restricted to `main`;
   - variable `NPM_PUBLISH_ENABLED=true`.
5. Restrict traditional token publishing and revoke bootstrap credentials
   after OIDC has been verified.

Create the matching package tag and GitHub Release during bootstrap when
possible. If they are missing, the guarded workflow can reconstruct them only
when npm `gitHead` is a reachable ancestor and that commit contains the same
package name and version.

The publish job uses a GitHub-hosted runner, `id-token: write`, npm 11.19.0,
and provenance. It does not read an `NPM_TOKEN`. Verification runs in a
separate read-only job without OIDC. That job uploads exact, checksummed npm
tarballs; the protected publish job publishes those tarballs without running
package lifecycle scripts.

## Package publication eligibility

Release eligibility is explicit in two places:

1. `scripts/workspaces.mjs` must set `releaseStatus: "publishable"`;
2. the matching package manifest must not set `"private": true`.

CI rejects mismatches. The guarded release scripts currently allow only
`@oai404iao/pi-keep-defaults` and `@oai404iao/pi-telegram-notify`. Both are
public at `0.1.3`; future releases require a maintainer to manually dispatch
and approve the guarded workflow. Their trusted-publisher configuration and
`NPM_PUBLISH_ENABLED` environment variable are release prerequisites.

`@oai404iao/pi-codex-minimal-tools`, `@oai404iao/pi-external-thinking`,
`@oai404iao/pi-subagent`, and `@oai404iao/pi-tree-continue` are private.
Promote one only in a dedicated reviewed change after its documented source,
compatibility, and release-track gates are complete. A prerelease package must
also use prerelease SemVer so the workflow selects the `next` dist-tag.

All package peer ranges currently require Pi 0.84.2 or newer. Update the
development baseline, peer ranges, lockfile, compatibility notes, and tests
together. Do not lower the minimum below the tested baseline. The open-ended
upper range is an intentional forward-compatibility policy; evaluate each new
Pi baseline in CI and tighten the range if an incompatibility is found.

Official references:

- [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/)
- [npm trust](https://docs.npmjs.com/cli/v11/commands/npm-trust/)
- [npm provenance](https://docs.npmjs.com/generating-provenance-statements/)

## Normal release flow

1. Add a changeset in each package-facing pull request:

   ```bash
   npm run changeset
   ```

2. Merge changes to `main`. `release-pr.yml` creates or updates the version PR.
3. Review generated versions and changelogs, then approve that PR's CI.
4. Merge the version PR.
5. Manually run `publish.yml` from `main`, enter `publish`, and approve the
   `npm-publish` environment deployment.
6. The read-only job reruns checks and packs immutable release artifacts.
7. The protected OIDC job validates repository/license metadata, publishes the
   exact tarballs, atomically pushes package tags, and creates package-specific
   GitHub Releases from their changelogs.

Tags use Changesets' package-level format:

```text
@oai404iao/pi-subagent@0.3.0
@oai404iao/pi-telegram-notify@0.1.3
```

Prerelease SemVer versions are published with the `next` dist-tag; stable
versions use `latest`. Do not promote experimental packages until
clean-install smoke tests pass.

## Recovery

- Never overwrite an npm version.
- If npm succeeds only for part of a release, the workflow reconciles each
  published package's npm `gitHead` but creates no new tags or GitHub Releases.
  A clean rerun recovers missing tags/Releases and publishes only versions
  still absent from npm.
- Recovery also verifies `latest` for stable versions and `next` for
  prereleases. Dist-tag mistakes fail with an interactive repair instruction;
  the OIDC workflow does not silently rewrite package tags.
- Recovery is refused when a current tarball-facing file changed after the
  published npm `gitHead` without a version bump. Add a changeset and release
  a new version instead of treating different package contents as a recovery.
- Tags are pushed atomically. Existing GitHub Releases are skipped, so release
  finalization is safe to retry.
- If a bad package is public, prefer a corrective patch or `npm deprecate`
  over routine unpublishing.
- Keep the publishing workflow disabled if npm ownership, provenance, source
  rights, tag identity, or repository metadata is uncertain.
