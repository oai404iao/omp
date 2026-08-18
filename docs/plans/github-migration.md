# GitHub migration plan

## Decisions

- Public repository target: `<owner>/omp`; the owner is intentionally unresolved.
- Keep the current unscoped npm package names during phase 1.
- Preserve and audit the existing Git history.
- Phase 1 changes release infrastructure only; plugin behavior is out of scope.
- GitHub will become the release source of truth. The private Gitea repository
  remains a backup/mirror until cutover is verified.

No placeholder GitHub URLs will be written into package metadata. Provenance
requires the final repository URL to match the real public repository exactly.

## Phase 1 — repository preparation

- [x] Add a private npm workspace with one root lockfile.
- [x] Add Changesets with independent package versions.
- [x] Add CI for package checks and npm tarball inspection.
- [x] Add a release-PR workflow.
- [x] Add a manually triggered, hard-disabled OIDC publish workflow with
      read-only verification and immutable tarball handoff.
- [x] Record the initial full-history and publication audit.
- [ ] Obtain the GitHub owner.
- [ ] Complete package licensing and third-party source review.
- [ ] Remove unnecessary test/build files from published tarballs.
- [ ] Add exact GitHub metadata to each package.

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

After verification, decide whether to rename remotes so GitHub becomes
`origin` and Gitea becomes `gitea`. That remote change is operational and is
not part of phase 1.

## Phase 3 — package identity

For all five npm workspaces:

1. Recheck exact package-name ownership.
2. Add real `repository`, `homepage`, and `bugs` metadata.
3. Resolve package-level license and notice requirements.
4. Audit the final `npm pack --dry-run --json` output.
5. Bootstrap each new npm package with interactive 2FA.
6. Record the bootstrap commit in npm `gitHead` and create matching tags.
7. Bind trusted publishing to `publish.yml` and `npm-publish`.

`external-thinking` remains incubating until it has its own manifest, tests,
compatibility handling, and upstream attribution.

## Phase 4 — enable releases

Open a dedicated pull request that changes only the release lock and any final
release-policy checks:

```yaml
RELEASE_INFRASTRUCTURE_ENABLED: "true"
```

Do not combine that change with plugin implementation work. Publish candidate
packages separately and use prerelease dist-tags for beta/experimental code.
