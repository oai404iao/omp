# GitHub migration plan

## Decisions

- Public repository target: `oai404iao/omp`.
- Use `@oai404iao/<package-name>` for all six npm workspace package names.
- Preserve and audit the existing Git history.
- Phase 1 changes release infrastructure only; plugin behavior is out of scope.
- GitHub is the public source repository and will become the release source of
  truth when npm publishing is enabled. The private Gitea repository remains a
  backup.

Repository URLs were added only after the empty public repository was created
and verified with GitHub CLI. Provenance requires package metadata to match
that repository exactly.

## Phase 1 — repository preparation

- [x] Add a private npm workspace with one root lockfile.
- [x] Add Changesets with independent package versions.
- [x] Add CI for package checks and npm tarball inspection.
- [x] Add a release-PR workflow.
- [x] Add a manually triggered OIDC publish workflow with
      read-only verification and immutable tarball handoff.
- [x] Record the initial full-history and publication audit.
- [x] Obtain the GitHub owner.
- [ ] Complete package licensing and third-party source review.
- [x] Remove unnecessary test/build files from published tarballs.
- [x] Add exact GitHub metadata to each package.

## Phase 2 — GitHub cutover

Before changing remotes:

```bash
git status --short
git rev-list --left-right --count origin/main...main
git merge-base --is-ancestor origin/main main
git fsck --full
git bundle create ../omp-before-publication.bundle --all
git bundle verify ../omp-before-publication.bundle
```

Expected baseline at the start of phase 1: `origin/main...main` is `0 3`.
Stop if the histories diverge in both directions.

Create an empty GitHub repository, obtain its URL from GitHub rather than
guessing it, and keep the Gitea remote:

```bash
git remote add github <verified-github-url>
git push --dry-run github main
git push github main
git push github --tags
git fetch github
test "$(git rev-parse main)" = "$(git rev-parse github/main)"
```

Do not use `git push --mirror`; it can publish unrelated local refs.

Cutover status:

- [x] Verify and retain the local `../omp-before-publication.bundle`.
- [x] Create the empty public `oai404iao/omp` repository.
- [x] Add the verified GitHub URL as the separate `github` remote.
- [x] Push `main` without mirroring unrelated refs.
- [x] Verify local `main` and `github/main` are identical.
- [x] Push the local tag set; it was empty at cutover.
- [x] Track `github/main` from the local `main` branch.

The original Gitea remote remains named `origin` so existing backup operations
do not change silently. Renaming remotes is optional and is not required for
GitHub to be the tracked public branch.

## Phase 3 — package identity

For all six npm workspaces:

1. Recheck exact scoped package-name ownership.
2. Add real `repository`, `homepage`, and `bugs` metadata.
3. Resolve package-level license and notice requirements.
4. Audit the final `npm pack --dry-run --json` output.
5. Bootstrap each new npm package with interactive 2FA.
6. Record the bootstrap commit in npm `gitHead` and create matching tags.
7. Bind trusted publishing to `publish.yml` and `npm-publish`.

`@oai404iao/pi-external-thinking` now has an audited manifest, tarball
allowlist, and behavior tests. It remains private until compatibility and
public-release review is complete. Its upstream attribution and license are
recorded.

The initial `0.1.2` bootstrap releases for
`@oai404iao/pi-keep-defaults` and `@oai404iao/pi-telegram-notify` were
published from `0c53bdb9e13b006a23a8da05a01c06f106fa2c10`, with matching tags
and GitHub Releases. Guarded publishing subsequently released `0.1.3` from
`16dccb8953b717670c34fe978c79c07d592ca7e2`. Their trusted publishers are
configured and guarded manual releases are enabled. The other workspaces set
`private: true` and require a separate promotion review.

## Phase 4 — enable releases

The release lock was enabled in a dedicated reviewed pull request:

```yaml
RELEASE_INFRASTRUCTURE_ENABLED: "true"
```

Do not combine future release-policy changes with plugin implementation work.
Publish candidate packages separately and use prerelease dist-tags for
beta/experimental code.
