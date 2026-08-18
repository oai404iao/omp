# Releasing

## Current state

Publication is intentionally disabled:

```yaml
RELEASE_INFRASTRUCTURE_ENABLED: "false"
```

in `.github/workflows/publish.yml`. Changing that value requires a separate,
reviewed pull request after every prerequisite below is complete.

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

5. Add reviewed package-level license files and all required third-party
   notices. Do not infer ownership from the existing `license` fields alone.
6. Protect `main`: require pull requests and CI, block force pushes and branch
   deletion, and require review for workflow changes.
7. Allow GitHub Actions to create release pull requests. PRs created with
   `GITHUB_TOKEN` may require a maintainer to approve their CI run.

## npm bootstrap and trusted publishing

An npm trusted publisher can only be attached after a package exists. For each
new package:

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
pi-subagent@0.3.0
pi-telegram-notify@0.1.1
```

Prerelease SemVer versions are published with the `next` dist-tag; stable
versions use `latest`. Do not promote experimental packages until
clean-install smoke tests pass.

## Recovery

- Never overwrite an npm version.
- If npm succeeds only for part of a release, the workflow reconciles each
  published package's npm `gitHead`, creates the recoverable tags, and then
  fails. A rerun recovers missing tags/Releases and publishes only versions
  still absent from npm.
- Recovery also verifies `latest` for stable versions and `next` for
  prereleases. Dist-tag mistakes fail with an interactive repair instruction;
  the OIDC workflow does not silently rewrite package tags.
- Tags are pushed atomically. Existing GitHub Releases are skipped, so release
  finalization is safe to retry.
- If a bad package is public, prefer a corrective patch or `npm deprecate`
  over routine unpublishing.
- Keep the publishing workflow disabled if npm ownership, provenance, source
  rights, tag identity, or repository metadata is uncertain.
