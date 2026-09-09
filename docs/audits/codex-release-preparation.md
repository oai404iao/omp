# Codex release preparation — blocked

This is a separate read-only preparation task based on local main
`556757897067b62e36bc4707f238de3335cd0d4e`. It does not authorize publication,
change eligibility, or claim production endpoint acceptance.

## Completed integration

- S1–S5, the FIFO correction and integration-review fixes are merged locally
  with a merge commit preserving the series.
- Four local combinations passed: Node 22.19.0 / 24.13.0 × Pi 0.84.2 / 0.85.1,
  all with npm 11.19.0. Each ran 514 node:test cases and 17 tarball/loader
  combinations. See [integration acceptance](codex-integration.md).
- Integrated main received a clean installation and another complete CI run.
  Production `npm audit --omit=dev --audit-level=high` passed.
- Original user work was saved separately as `c1282b6e` on
  `wip/subagent-redesign-local`, checked out at
  `.worktrees/wip-subagent-redesign-local`. All eight selected files matched
  their pre-save SHA-256 values. That commit is not an ancestor of integrated
  main; its design/configuration work was not merged into the refactor.
- No branch, tag or package was pushed or published.

## Registry and account observations

These are point-in-time observations, not reserved names or permanent permission
guarantees. Commands used the explicit registry `https://registry.npmjs.org/`.

| Check | Observed result | Meaning |
| --- | --- | --- |
| `npm whoami --json` | E401 | Current npm identity was not authenticated |
| `@oai404iao/pi-codex-runtime` metadata | E404 | Not visible to this request |
| `@oai404iao/pi-codex-core` metadata | E404 | Not visible to this request |
| `@oai404iao/pi-codex-web-search` metadata | E404 | Not visible to this request |
| `@oai404iao/pi-codex-imagegen` metadata | E404 | Not visible to this request |
| Existing compatibility bundle metadata | Public, latest 1.4.0, maintainer `oai404iao` | Public registry control query succeeded |

E404 does not prove name availability: an inaccessible private package or name
policy can still prevent creation. No package-name reservation was attempted.
Because whoami failed, npm write access and trusted-publisher configuration could
not be accepted. No login, token creation/revocation, OTP submission or credential
file modification was attempted.

The current bundle version already exists publicly; the refactored payload must
receive its reviewed version bump, not be treated as recovery of unchanged 1.4.0.
The historical release lock was not rewritten.

## GitHub observations

Read-only API calls to `oai404iao/omp` reported:

- Public repository; current GitHub credential has admin/maintain/push access.
- `npm-publish` exists and requires reviewer `oai404iao`.
- `prevent_self_review` is false; the environment is not an independent-review
  guarantee.
- Deployment policy allows protected branches. The checked-in workflow adds its
  own `refs/heads/main` condition and exact confirmation/preflight gates.
- `NPM_PUBLISH_ENABLED` is already `true`; it was not changed.
- Public main was `a93559be8f8b02739310c492b36270b13607fbf9`.
  The local integration commit is not yet reachable from that public head.

GitHub permissions do not establish npm ownership or OIDC authorization.
Trusted publishing is bound to the configured provider/repository/workflow and
optional environment; verify these independently before enabling new packages.
See [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/).

## Preserved release gates

Both ordinary and bootstrap artifact preparation rejected:

```text
Release blocked by unpublished workspace dependency:
@oai404iao/pi-codex-minimal-tools -> @oai404iao/pi-codex-runtime
```

No `release-artifacts/` directory was created. Runtime/core/web-search/imagegen
remain private and blocked; the private tree-continue package also remains
blocked. No release locks, bootstrap allowlist, protected environments, workflow
permissions, dist-tags or package versions were changed.

## Maintainer actions before proceeding

1. Reauthenticate npm interactively outside the agent conversation; do not paste
   credentials here. Verify the intended identity and package/scope rights using
   read-only `npm whoami` and `npm access list` commands. See
   [npm access](https://docs.npmjs.com/cli/v11/commands/npm-access/).
2. Recheck the four names with that identity. Separately review the source,
   licenses, exported surface, release versions and dependency-first bootstrap
   plan. Any private/blocked → bootstrap change needs its own explicit approval
   and dedicated reviewed commit; this document is not that approval.
3. Authorize public Git synchronization/review separately. Bootstrap preparation
   requires source reachable from freshly fetched public main; a local merge is
   insufficient.
4. Review the actual Changesets version PR, exact dependency pins and changelogs.
   Do not directly run bare Changesets version or bypass the dependency closure.
5. Obtain explicit endpoint smoke authorization specifying authentication source,
   exact model/profile, allowed requests and spending limit. Use small controlled
   tests for transport/replay, search and image generation as approved. Local
   fixtures do not prove account permissions, model availability or billing safety.
6. Only after separate publication approval, perform the reviewed interactive
   bootstrap and configure/verify each new package's trusted publisher. Preserve
   the guarded workflow and registry identity/integrity checks.

Real model/endpoint calls, bootstrap, npm publication and remote CI execution
remain **not performed**.
