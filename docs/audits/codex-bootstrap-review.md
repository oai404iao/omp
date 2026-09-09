# Codex bootstrap review — proposal only

This review follows local integration `55675789` and preparation `383c05f3`.
The maintainer requested a prerelease plan and a public review PR, but did not
authorize changing package eligibility, publishing npm packages, or bypassing
the protected main/release workflow.

## 1. Actual Changesets simulation

A temporary source copy ran the repository's real CLI workflow with Node
24.13.0 and npm 11.19.0:

```bash
npm ci --ignore-scripts
node_modules/.bin/changeset pre enter alpha
npm run changeset:version
npm run changeset:check
```

The version wrapper, not bare Changesets version, handled exact dependency pins
and lock integrity. A second wrapper invocation left the lock hash unchanged.
A clean installation of the simulated graph and complete `npm run ci` passed
514 node:test cases plus 17 production tarball/Pi 0.85.1 loader combinations.
The simulated versions were not applied to the real worktree, and no active
prerelease state or second project lock was committed.

| Package (scope `@oai404iao/`) | Simulated first alpha | Current eligibility |
| --- | --- | --- |
| pi-codex-runtime | 0.1.0-alpha.1 | private / blocked |
| pi-codex-core | 0.1.0-alpha.1 | private / blocked |
| pi-codex-web-search | 0.1.0-alpha.1 | private / blocked |
| pi-codex-imagegen | 0.1.0-alpha.1 | private / blocked |
| pi-codex-minimal-tools | 1.4.1-alpha.0 | publishable, dependency-blocked |
| pi-subagent | 0.4.0-alpha.0 | publishable, dependency-blocked |
| pi-external-thinking | 0.1.1-alpha.0 | publishable |
| pi-keep-defaults | 0.1.4-alpha.0 | publishable |
| pi-telegram-notify | 0.1.4-alpha.0 | publishable |
| pi-tree-continue | unchanged 0.1.0 | private / blocked |

This is a **nine-package prerelease plan**, not approval to publish nine packages.
The existing pending changesets include the last three public packages. If the
maintainer wants a narrower release, their unrelated changesets must first be
explicitly split/deferred and the real version simulation rerun. Do not silently
drop dependency consumers or change the versioning script to hide them.

The dependency order and exact simulated pins are:

```text
runtime@0.1.0-alpha.1
  -> core / web-search / imagegen @0.1.0-alpha.1
  -> compatibility bundle@1.4.1-alpha.0
  -> subagent@0.4.0-alpha.0 (optional exact bundle dependency)
```

All three capability packages depend exactly on runtime. The bundle pins runtime
and all three capabilities. Prerelease artifacts select the `next` dist-tag;
they must not be promoted to `latest` by following a stable bootstrap example.
An alpha-only new package should be requested explicitly with `@next` or its
exact version until a separately approved stable release exists.

## 2. Eligibility proposal — not applied

Only after independent approval would a dedicated eligibility change:

- change the four new package manifests from private to non-private;
- move those four `scripts/workspaces.mjs` entries from blocked to bootstrap;
- leave `pi-tree-continue` private, blocked and exact-Pi-0.84.2;
- preserve the entire dependency closure, licenses, provenance and guarded
  publish workflow; no release lock entry is invented before registry evidence.

No such changes are present in this PR. Existing bundle/subagent trust
configuration applies only to those existing packages, not to the new four.
E404 metadata responses remain visibility observations rather than proof of
name availability. See [release preparation](codex-release-preparation.md).

The future bootstrap must use reviewed source reachable from public main,
publish dependencies before dependents, and verify each package's gitHead and
integrity before proceeding. The later bootstrap-to-publishable transition and
new trusted-publisher configuration require separate approval and evidence.

## 3. Real endpoint smoke — explicitly deferred

The maintainer initially authorized the current Pi configuration, at most two
text requests, at most 128 output tokens per request, and a US$1 ceiling, with
no automatic retries, prewarm, search or image calls.

Read-only inspection found a configured current model and authentication source,
but the endpoint is a custom gateway. Local model cost metadata does not establish
that gateway's actual billing. No model request was sent. The maintainer then
explicitly chose to pause real smoke and continue the proposal/public PR.

- Model requests: **0**.
- Search/image requests: **0**.
- Real account model access, transport/replay and billing: **not accepted**.
- No credentials, gateway URLs, account headers or local configuration files
  are included in this review.

Resume only after renewed authorization and a verifiable gateway price or
account-side budget constraint. The mock CI matrix is not a replacement for
this pending acceptance.

## 4. Public review scope

The public branch includes the reviewed integration series and its prerequisite
subagent commits already present on local main before S1. This is not merely a
four-package metadata PR; reviewers must examine the full diff against public
main. The separate `wip/subagent-redesign-local` branch and its design files are
not ancestors of this branch and must not be pushed as part of this task.

Public-history review uses the proposed branch's `github/main..HEAD` range,
not `--all`, so unrelated private WIP refs are not published or mistaken for the
PR payload. The legacy root audit script assumes main and fetches the separate
forge remote; it is not run unchanged from this review branch.

The PR remains a draft pending review and real smoke. No remote merge, release
dispatch, eligibility activation, npm publication or dist-tag mutation is part
of this task.
