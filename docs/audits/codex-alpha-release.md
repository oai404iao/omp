# Codex alpha release preparation — publication pending

## Approval and integration

The maintainer explicitly approved:

- squash-merging PR #36 under the repository's existing linear-history policy;
- replacing obsolete required check names with all four Node/Pi CI lanes,
  while retaining the other main protections;
- disabling automatic branch deletion and preserving the old local main;
- preparing all nine eligible workspace packages as alpha versions;
- making only runtime/core/web-search/imagegen non-private on the bootstrap
  track in a separate preparation PR.

[PR #36](https://github.com/oai404iao/omp/pull/36) was squash-merged as
`952cb3f2d011c8c9ecd3e9b2e3bebbb354c69d66`. Its tree matches the reviewed PR head.
The four post-merge CI lanes passed in
[run 34332966977](https://github.com/oai404iao/omp/actions/runs/34332966977).
The original local integration is retained as `archive/main-before-pr36`,
and the original topic branches/worktrees remain intact. Subagent redesign WIP
is still separate and was not included in the public merge.

These approvals do **not** authorize npm publication, dist-tag changes, release
workflow dispatch, bootstrap-to-publishable promotion, or renewed model calls.

## Actual alpha graph

Unlike the earlier temporary proposal, this preparation PR applies real versions,
changelogs, exact dependency pins and the single root lock:

```bash
npm run changeset:sync
node_modules/.bin/changeset pre enter alpha
npm run changeset:version
npm run changeset:check
```

- runtime/core/web-search/imagegen: **0.1.0-alpha.1**, bootstrap only.
- compatibility bundle: **1.4.1-alpha.0**, guarded publication dependency-blocked.
- subagent: **0.4.0-alpha.0**, guarded publication dependency-blocked.
- external-thinking: **0.1.1-alpha.0**.
- keep-defaults and telegram-notify: **0.1.4-alpha.0**.
- tree-continue: unchanged **0.1.0**, private/blocked, exact Pi **0.84.2**.

The consumed changesets are retained under `.changeset/pre/`; the active alpha
state is committed as `.changeset/pre.json`. Two consecutive repeat invocations
of the version wrapper preserved the root lock hash. External locked package
entries, including all integrity values, are semantically unchanged.

The bootstrap-eligibility tests failed against the old blocked metadata, then
passed after the approved metadata change. They assert the exact four-package
opt-in set, preserve tree-continue exclusion, reject ordinary incomplete batches,
and accept the complete local bootstrap dependency closure. Versioning fixtures
still exercise a private runtime dependency and verify that version changes
preserve every package's privacy setting.

No runtime implementation, Pi baseline, architecture budget, license snapshot,
provenance evidence or historical release lock is changed by this preparation.

## Remaining gates

1. Review and merge this preparation PR only after its own CI passes. The
   automatic stable version PR generated immediately after PR #36 is not the
   approved alpha plan; do not merge it ahead of this preparation.
2. Reauthorize and complete real endpoint acceptance once gateway pricing or an
   account-side budget constraint is established. The maintainer explicitly
   paused the earlier US$1/two-text-request smoke; model requests remain **0**.
   No gateway URLs or credentials are included here.
3. Recheck registry identity, exact-version visibility and package rights before
   publication. Prior E404 results do not reserve names.
4. From a clean, freshly fetched public-main source containing this approved
   preparation, run the full checks and `npm run release:bootstrap-artifacts`.
   Ordinary artifact preparation still excludes the bootstrap dependencies.
   A version PR head that is merely public is not enough: it must be reachable
   from public main.
5. Obtain explicit publication approval before using the prepared tarballs.
   Initially publish only runtime, then core/web-search/imagegen, with interactive
   authentication and the prepared `next` dist-tag. Do not publish the dependent
   bundle/subagent early.
6. Verify each initial package's gitHead and SHA-512 integrity, configure its
   trusted publisher, then review a separate bootstrap-to-publishable activation
   and record the actual registry evidence in the release lock. No lock entry
   is invented during preparation.
7. Only after that activation and publication approval may the guarded workflow
   recover/verify those dependency nodes and publish the remaining alpha
   consumers. Prereleases stay on `next`, not `latest`.

There is no npm publication, tag/Release creation, remote merge of this
preparation PR, or release-workflow dispatch in this preparation task.
