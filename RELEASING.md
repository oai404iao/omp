# Releasing

## Codex bootstrap activation

The four new Codex workspaces were manually published at `0.1.0-alpha.1` from
`32ba01f3c08b7fd63d09e9b2373cf081c4525533`. Their registry identity, downloaded
tarball SHA-512 and trusted publishers have been independently verified.
This dedicated activation checkout moves them to `publishable` and records
their exact artifacts in the release lock. Its merge and actual protected
publication still require separate approval.

Ordinary preparation now includes all nine alpha packages: four immutable
`recover` dependencies plus five `publish` candidates. Do not republish the
initial four, ignore dependencies, or replace locked artifacts. A known locked
version returning E404 is pending verification, not a fresh publication candidate.
See [activation evidence](docs/audits/codex-bootstrap-activation.md).

S4 implements recursive exact-pin changesets, dependency-ordered artifacts and
no-links production consumers. These tests do not authorize registry writes or
verify real account/model access. See
[Codex composition](docs/codex-packages.md) for the tested boundaries.

Use `npm run changeset:sync` after authoring a changeset. Its generated consumer
changeset covers `dependencies` and `optionalDependencies` recursively, including
subagent's optional dependency on the compatibility bundle. The release-PR
workflow already calls `npm run changeset:version`; that wrapper preserves exact
pins and rejects pin changes without a corresponding consumer version bump.
Its tests version temporary fixtures; actual alpha versions belong in a reviewed
version PR, never in an unreviewed direct main update.

The approved preparation cohort is nine alpha packages (all workspaces except
tree-continue). `.changeset/pre.json` records the `alpha` channel, while release
artifacts use the `next` dist-tag. Limited real smoke on the immutable bootstrap
artifacts has been performed, with important harness/coverage limitations
recorded in the activation audit; it is not universal endpoint acceptance.
Remaining publication requires separate approval. The earlier
[alpha preparation audit](docs/audits/codex-alpha-release.md) is a historical checkpoint.

Artifact preparation and publication both apply a stable dependency-first order.
Every workspace dependency must be present in the batch, including a recovery
candidate for an already-published dependency. The publisher validates the whole
batch before any registry write, then verifies each exact version's gitHead and
integrity before proceeding to dependents. Failure stops subsequent publication;
final reconciliation still gates all tag creation.

## Workflow state and historical bootstraps

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

Both packages subsequently released stable version `0.1.3` from
`16dccb8953b717670c34fe978c79c07d592ca7e2`.

`@oai404iao/pi-external-thinking@0.1.0` is public, published from
`aae803f4b25603991d9375c602cf35da1df922b0`; its npm `gitHead`, package tag,
and GitHub Release match that commit.

`@oai404iao/pi-subagent@0.2.0` is public, published from
`ef42984c0e40ef1f26ead4b4c7d149b21280e66b`; its npm `gitHead` and `latest`
dist-tag were verified at that bootstrap checkpoint. Its trusted publisher was configured for guarded
tag/Release reconciliation and future OIDC releases.

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

For a workspace on the `bootstrap` track:

1. Fetch public `main`, then check out a clean commit reachable from it (use
   `git fetch github main` and normally `git checkout github/main`). Run
   `npm ci --ignore-scripts`, `npm run ci`, and
   `npm run release:bootstrap-artifacts`.
2. Publish only that workspace's named tarball from `release-artifacts/` with
   interactive 2FA and `--access public`, using the prepared manifest's
   `distTag`: `next` for prereleases, `latest` for stable releases. Do not
   explicitly publish a prerelease with `--tag latest`. npm retains a `latest`
   tag for a new package; the reviewed initial Codex exception below handles
   that alias without trying to delete it. Bootstrap artifacts cannot be
   prepared from GitHub Actions.
3. Configure its trusted publisher, then merge a dedicated reviewed change
   from `bootstrap` to `publishable`. That activation change must record the
   reviewed npm `gitHead` and SHA-512 integrity in
   `release-locks/npm-published-artifacts.json`.
4. Dispatch the guarded workflow to reconcile the matching Git tag and GitHub
   Release. Do not dispatch it while the package remains on `bootstrap`.

Create the matching package tag and GitHub Release during bootstrap when
possible. If they are missing, the guarded workflow can reconstruct them only
after the package is `publishable`, npm `gitHead` is a reachable ancestor, and
that commit contains the same package name and version.

The publish job uses a GitHub-hosted runner, `id-token: write`, npm 11.19.0,
and provenance. It does not read an `NPM_TOKEN`. Verification runs in a
separate read-only job without OIDC. That job uploads exact, checksummed npm
tarballs; the protected publish job publishes those tarballs without running
package lifecycle scripts.

## Package publication eligibility

Release eligibility is explicit in two places:

1. `scripts/workspaces.mjs` must set one of:
   - `blocked`: package stays private and is excluded from artifacts;
   - `bootstrap`: package is non-private but is included only by the local
     `npm run release:bootstrap-artifacts` command;
   - `publishable`: package is non-private and enters guarded workflow
     artifacts.
2. only `blocked` packages may set `"private": true`.

CI rejects mismatches. The guarded release scripts now select all nine packages
other than `pi-tree-continue`, including the four verified Codex recovery nodes.
The historical manual releases below remain locked; they are not a live registry
inventory. See the root README and activation audit for this alpha cohort.
All future releases require a maintainer to manually dispatch and approve the
guarded workflow. Their trusted-publisher configuration and
`NPM_PUBLISH_ENABLED` environment variable are release prerequisites.

`@oai404iao/pi-codex-minimal-tools@1.3.0` was manually bootstrapped from
`596d799c6f7db3508b6d46bb05cdca6ea9e3b716`. Its Apache source map is
recorded in `pi-extensions/pi-codex-minimal-tools/provenance/`; its internal
Responses Lite compatibility boundary remains documented in the package README
and notice. Its trusted publisher is configured, so it now enters guarded
GitHub Actions release artifacts. `@oai404iao/pi-tree-continue` remains
private. A prerelease package must also use prerelease SemVer so the workflow
selects the `next` dist-tag.

The recovery guard compares the registry `gitHead` and SHA-512 integrity with
any matching entry in `release-locks/npm-published-artifacts.json`. Add an
entry when an interactive bootstrap is verified; do not alter a locked value
without a separate source-and-registry investigation.

### Initial Codex `latest` alias

npm's registry metadata requires a `latest` tag. The first runtime publication
has both `next` and `latest` pointing to its only version; removing `latest`
returned E400. Do not unpublish, republish, publish a dummy stable version, or
delete the tag to work around this. See the
[official registry schema](https://github.com/npm/registry/blob/main/docs/REGISTRY-API.md#package).

The maintainer approved a narrow exception recorded in
`scripts/initial-codex-bootstrap.mjs`: only runtime/core/imagegen/web-search
at `0.1.0-alpha.1` from reviewed source
`32ba01f3c08b7fd63d09e9b2373cf081c4525533`, with `next` and `latest` both pointing
to that version and no other published version visible in registry history.
This does not declare the alpha stable. A version-less install of a new package
can resolve to that alpha; prefer explicit `@next` or exact versions.

The guarded publisher accepts this alias only for an already-published
`recover` candidate with matching reviewed release-lock gitHead/integrity.
The dedicated activation now admits those four recovery nodes into guarded
artifacts; generic bootstrap/private-package exclusion remains enforced.
Missing/malformed history,
missing locks, other packages, later versions or a wrong `next` still fail
closed. Existing stable packages retain their prerelease/latest prohibition.
Tags are checked before proceeding to consumers and again during reconciliation.
Neither the publisher nor the local verifier edits registry tags.

The local interactive bootstrap verifier uses the same tag predicate after
validating the prepared artifact and published identity; it cannot require a
release-lock entry that is only added after verified bootstrap. See
[the correction record](docs/audits/codex-bootstrap-latest.md).

Public and supported-package peer ranges currently require Pi 0.85.1 or
newer; the exact development target is also 0.85.1, with both lock-validation
roles checked by `npm run ci:pi-matrix`. Actual SDK resolution is checked, not
inferred from peer declarations. Update the development baseline, peer ranges,
lockfile, compatibility notes, and tests together. Do not lower the minimum
below the tested baseline.
The open-ended upper range is an intentional forward-compatibility policy;
evaluate each new Pi baseline in CI and tighten the range if an incompatibility
is found. `@oai404iao/pi-tree-continue` is audited against the exact 0.85.1
baseline while it remains a private unsupported hook into Pi internals, so it
stays blocked from publication.
See [Pi compatibility](docs/pi-compatibility.md) for the verified scope and
upstream 0.85.0 SDK caveat.

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
   exact tarballs, waits for each package's exact npm metadata and dist-tag to
   become visible, atomically pushes package tags, and creates package-specific
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
- After a successful `npm publish`, only the read-side registry checks are
  retried. Exact-version metadata and dist-tags use cache-revalidating
  `--prefer-online` lookups with capped exponential backoff for up to three
  minutes per newly published package. The workflow never blindly retries the
  irreversible publish command.
  The timeout, initial delay, and maximum delay are controlled by
  `NPM_REGISTRY_PROPAGATION_TIMEOUT_MS`,
  `NPM_REGISTRY_PROPAGATION_INITIAL_DELAY_MS`, and
  `NPM_REGISTRY_PROPAGATION_MAX_DELAY_MS`.
- A release-lock entry is evidence that a version was already published.
  If its metadata lookup returns E404, preparation stops as pending verification
  without packing or publishing that version. Do not remove the lock to proceed.
- If npm succeeds only for part of a release, the workflow reconciles each
  published package's npm `gitHead` but creates no new tags or GitHub Releases.
  If registry visibility still exceeds the bounded wait, a clean rerun recovers
  missing tags/Releases and publishes only versions still absent from npm.
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
