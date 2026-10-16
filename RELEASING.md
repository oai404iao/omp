# Releasing

## Codex bootstrap activation

The four new Codex workspaces were manually published at `0.1.0-alpha.1` from
`32ba01f3c08b7fd63d09e9b2373cf081c4525533`. Their registry identity, downloaded
tarball SHA-512 and trusted publishers have been independently verified.
This dedicated activation checkout moves them to `publishable` and records
their exact artifacts in the release lock. Its merge and actual protected
publication still require separate approval.

The bootstrap activation originally included nine alpha packages: four immutable
`recover` dependencies plus five `publish` candidates. Do not republish the
initial four, ignore dependencies, or replace locked artifacts. A known locked
version returning E404 is pending verification, not a fresh publication candidate.
See [activation evidence](docs/audits/codex-bootstrap-activation.md).

S4 implements recursive exact-pin changesets, dependency-ordered artifacts and
isolated production consumers with no external links. These tests do not authorize registry writes or
verify real account/model access. See
[Codex composition](docs/codex-packages.md) for the tested boundaries.

Use `pnpm run changeset:sync` after authoring a changeset. Its generated consumer
changeset covers `dependencies` and `optionalDependencies` recursively, including
subagent's optional dependency on the compatibility bundle. The release-PR
workflow already calls `pnpm run changeset:version`; that wrapper preserves exact
pins and rejects pin changes without a corresponding consumer version bump.
Its tests version temporary fixtures; actual alpha versions belong in a reviewed
version PR, never in an unreviewed direct main update.

The original preparation cohort was nine alpha packages. The current artifact
selection contains eight publishable workspaces: external-thinking, keep-defaults,
tree-continue, and the unpublished Code Mode experiment have been removed.
Historical release locks are retained, but removed packages must not enter
new artifact batches.
Prerelease artifacts use the `next` dist-tag when prerelease mode is active.
Limited real smoke on the immutable bootstrap
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

### Codex tools first publication and activation

Tools was manually bootstrapped at `0.1.0-alpha.1` from
`b9deaba6ba07d87c048e474b2ddc977f3bd2b442`. Its public tarball, registry
source/integrity, history/tags and trusted publisher were verified before this
separate activation to `releaseStatus:"publishable"`; see
[activation evidence](docs/audits/codex-tools-bootstrap-activation.md).
No existing version may be overwritten. Tools now uses the normal targeted
guarded workflow, not the local bootstrap command.

The first-publication sequence below is retained as bootstrap procedure/history.
Prerequisites through tools activation are complete; compatibility consumers
still require separate dispatch, with minimal-tools last:

1. Merge the reviewed prerequisite version PR and publish runtime, then core,
   using the existing targeted protected workflow (`package` set to each exact
   scoped name). Version PRs synchronize exact consumer pins and required version
   bumps; that does not authorize publishing consumers early. Keep unrelated
   Telegram changesets deferred. Do not merge a competing broad version PR.
2. After the exact runtime dependency is visible on npm, prepare **only tools**
   from a clean reviewed public-main commit:

   ```sh
   RELEASE_PACKAGE=@oai404iao/pi-codex-tools pnpm run release:bootstrap-artifacts
   ```

   The local bootstrap selector requires a bootstrap target, a complete
   published/publishable dependency closure, exact pins and public-main ancestry.
   Dependency candidates use verification-only mode; only tools gets a tarball.
   Missing prerequisites stop preparation. GitHub Actions and the guarded
   publisher cannot bootstrap tools.
3. The maintainer publishes the named tools tarball with interactive 2FA,
   `--access public --tag next --registry https://registry.npmjs.org/`.
   Do not publish from the source directory or run the full-batch publisher.
   Read back version, `gitHead`, SHA-512 integrity, version history and tags
   against the prepared manifest before recording any immutable lock.
4. Configure tools' trusted publisher. Prepare a separate reviewed activation
   change with the observed immutable source/integrity. If npm assigns its
   mandatory initial `latest` alias as well as `next`, record a narrow exact
   tools-version/source exception after verification; the historical four-package
   exception does not cover tools. Do not delete or overwrite historical locks.
5. Publish the web-search/imagegen compatibility consumers only after tools is
   published and activated. Publish minimal-tools last, through its reviewed
   release PR/protected workflow, followed by affected optional consumers.

To retain tools' still-unpublished initial version while preparing prerequisite
versions, use the canonical wrapper:

```sh
pnpm run changeset:version --preserve-bootstrap-version @oai404iao/pi-codex-tools
```

This explicit option checks bootstrap eligibility, absence from the immutable
lock and public registry **before writes**. It runs normal Changesets, preserves
only that validated initial version, and still repairs exact pins and requires
all other consumer bumps. It is refused once the version exists on npm. Normal
versioning behavior is unchanged. Pending changesets unrelated to this release
must be deferred/restored as in the targeted release guidance below.

For a workspace on the `bootstrap` track:

1. Fetch public `main`, then check out a clean commit reachable from it (use
   `git fetch github main` and normally `git checkout github/main`). Run
   `pnpm install --frozen-lockfile --ignore-scripts`, `pnpm run ci`, and
   `pnpm run release:bootstrap-artifacts`.
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
package lifecycle scripts. Development, verification and lockfile updates use
the repository-pinned pnpm 12.4.1; npm remains the registry publication client.

## Package publication eligibility

Release eligibility is explicit in two places:

1. `scripts/workspaces.mjs` must set one of:
   - `blocked`: package stays private and is excluded from artifacts;
   - `bootstrap`: package is non-private but is included only by the local
     `pnpm run release:bootstrap-artifacts` command;
   - `publishable`: package is non-private and enters guarded workflow
     artifacts.
2. only `blocked` packages may set `"private": true`.

CI rejects mismatches. The guarded release scripts select the eight publishable
workspaces, excluding removed external-thinking, keep-defaults, tree-continue,
and Code Mode.
The historical manual releases below remain locked; they are not a live registry
inventory. See the root README and activation audit for this alpha cohort.
All future releases require a maintainer to manually dispatch and approve the
guarded workflow. Their trusted-publisher configuration and
`NPM_PUBLISH_ENABLED` environment variable are release prerequisites.

`@oai404iao/pi-codex-minimal-tools@1.3.0` was manually bootstrapped from
`596d799c6f7db3508b6d46bb05cdca6ea9e3b716`. Its Apache source map is
recorded in `pi-extensions/pi-codex-runtime/provenance/`; its internal
Responses Lite compatibility boundary remains documented in the package README
and notice. Its trusted publisher is configured, so it now enters guarded
GitHub Actions release artifacts. A prerelease package must also use prerelease SemVer so the workflow
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

The separate tools activation adds only
`@oai404iao/pi-codex-tools@0.1.0-alpha.1` from
`b9deaba6ba07d87c048e474b2ddc977f3bd2b442`. Its exact verified history is
`0.0.0-stage` plus `0.1.0-alpha.1`: npm generated the former as a `stub:true`
[staged-publication placeholder](https://docs.npmjs.com/staged-publishing/).
Only this exact tools identity/history may retain its initial `latest`/`next`
alias. The historical four-package rule stays sole-version-only; no generic
placeholder filtering or prerelease promotion is allowed.

The guarded publisher accepts this alias only for an already-published
`recover` candidate with matching reviewed release-lock gitHead/integrity.
The dedicated activations admit those reviewed recovery nodes into guarded
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

Public and supported-package peer ranges currently require Pi 1.2.0 or
newer; the exact development target is 1.2.0, with both lock-validation
roles checked by `pnpm run ci:pi-matrix`. Actual SDK resolution is checked, not
inferred from peer declarations. Update the development baseline, peer ranges,
lockfile, compatibility notes, and tests together. Do not lower the minimum
below the tested baseline.
The open-ended upper range is an intentional forward-compatibility policy;
evaluate each new Pi baseline in CI and tighten the range if an incompatibility
is found.
See [Pi compatibility](docs/pi-compatibility.md) for the verified scope and
the transcript-context migration.

Official references:

- [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/)
- [npm trust](https://docs.npmjs.com/cli/v11/commands/npm-trust/)
- [npm provenance](https://docs.npmjs.com/generating-provenance-statements/)

## Normal release flow

### Pi 0.86.1 migration release note

Include this retirement notice in the migration release announcement:
`@oai404iao/pi-keep-defaults` is retired from this repository and future artifact
batches. Existing users must remove their installed copy and fully restart Pi;
`/reload` cannot reliably remove its old process-global patches. Pi 0.86.1 keeps
ordinary model/thinking changes session-local, but the retired settings-file
watcher's stronger protection against explicit saves and external edits is
intentionally **not** retained. For npm installations, run
`pi remove npm:@oai404iao/pi-keep-defaults` (add `-l` for a project-local install).
For local-path installations, remove the configured source instead.

The last recorded stable release is `0.1.3`; there is no new retirement package
version or changeset for the removed workspace. This change does not run
`npm deprecate`, unpublish, or alter installed copies. Thus existing npm users
will not receive a registry-level deprecation warning; any such operation needs
separate publication authorization.

### Release steps

1. Add a changeset in each package-facing pull request:

   ```bash
   pnpm run changeset
   ```

2. Merge changes to `main`. After its CI succeeds, `release-pr.yml` creates or
   updates the version PR without rerunning `pnpm run ci`. It accepts only a
   successful canonical CI **push** run from this repository's own `main`,
   verifies the current run/attempt through the API, and requires its SHA to
   equal both live main and the native workflow context SHA. PR/fork, stale,
   failed and superseded completions fail closed. The trusted workflow revision
   supplies the guard; no upstream artifacts or unverified ref code are used.
   The exact verified SHA is checked out and revalidated immediately before
   Changesets writes. Release PR runs serialize; a concurrent external main push
   after that final check can leave a stale version PR, which still requires its
   own review and PR CI. The newer main must pass CI before its release update.
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

### Targeted package releases

The optional `package` input on `publish.yml` accepts one exact publishable
workspace name, such as `@oai404iao/pi-subagent`. Leave it empty for the normal
full-batch release. The same selection is enforced during artifact preparation
and protected publication; it does not change any workspace's release eligibility.

Before dispatch, prepare and review a version PR containing only that package's
version bump and changelog. Split shared changesets so other packages' pending
entries remain unconsumed. Use `pnpm run changeset:version`, not manual manifest
version edits; restore deferred changesets and run `pnpm run changeset:sync`
before committing. If a pending dependency release generates a new consumer
changeset for the just-versioned package, retain it for the later batch.

Targeted publication retains the package's existing exact workspace dependency
pins. Every transitive workspace dependency must already exist on npm at that
exact version. Dependencies enter the artifact manifest in verification-only
mode: validate their immutable registry identity, source ancestry and dependency
contracts, but never publish them or create their tags/GitHub Releases.
Unreleased dependency source edits are not shipped and are not represented as
recovery of the current checkout. Missing or mismatched dependencies stop the
release rather than falling back to publishing them. The selected package itself
still obeys the ordinary unchanged-payload guard when recovering a published
version.
Dependency runtime, optional and peer dependency maps must match their published
source manifests; a pending dependency-contract change therefore blocks this
path even when its version number is unchanged. Current npm dist-tags need not
point to these immutable pinned dependency versions.

The normal release-PR automation may continue updating the deferred full-batch
version PR. Leave that PR unmerged while preparing and dispatching the targeted
release.

Local artifact preparation uses `RELEASE_PACKAGE=<exact-name> pnpm run
release:artifacts`. Dispatch still requires `confirm=publish`, successful
verification, and approval of the protected `npm-publish` environment.

## Recovery

- The publisher explicitly disables inherited npm `dry-run` configuration and
  retains npm's publish receipt in the job log. Exit zero still is not proof of
  publication: registry version, source, integrity and dist-tag checks remain
  authoritative. If a receipt reports success but readback stays absent, inspect
  npm's output and current registry state before starting another attempt; do
  not turn a readback failure into an automatic second publish.
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
