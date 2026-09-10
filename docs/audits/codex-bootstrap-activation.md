# Codex bootstrap activation

## Scope and authority

The maintainer reported completing all four interactive bootstrap publications,
then configured their trusted publishers and explicitly authorized this separate
activation PR. Merge and protected workflow dispatch remain separate decisions.
No npm publish, dist-tag mutation, trust mutation or workflow dispatch is performed
by this change. The unrelated stable-version PR #38 was closed as superseded.

The only eligibility changes are runtime/core/web-search/imagegen:
`bootstrap` → `publishable`. Package versions and every tarball-facing file remain
unchanged; tree-continue remains private/blocked at its exact Pi baseline.
Existing lock entries are preserved. Four new records use verified registry
identity and downloaded bytes, not locally invented hashes.

## Registry evidence — 2026-09-10

All four have version `0.1.0-alpha.1` and npm gitHead
`32ba01f3c08b7fd63d09e9b2373cf081c4525533`.

| Package (`@oai404iao/` scope) | Downloaded tarball bytes | Metadata and tarball |
| --- | ---: | --- |
| pi-codex-runtime | 59,346 | HTTP 200; source and SHA-512 match |
| pi-codex-core | 61,884 | HTTP 200; source and SHA-512 match |
| pi-codex-imagegen | 24,729 | HTTP 200; source and SHA-512 match |
| pi-codex-web-search | 17,741 | HTTP 200; source and SHA-512 match |

Anonymous GETs to `registry.npmjs.org` read each package's full metadata and
downloaded its registry-hosted tarball. Computed SHA-512 matched both metadata
and the exact reviewed bootstrap tarball. The full integrity values are pinned
in [the release lock](../../release-locks/npm-published-artifacts.json).
Subsequent npm 11.19.0 CLI verification also passed for all four.

At 03:06 UTC the latter three metadata queries returned 404; at 03:17 UTC all
four metadata/tarball queries succeeded. This is evidence of temporary lookup
invisibility, not a failed publish. The precise propagation/cache cause was not
established. Submission must not be repeated merely because a query returns 404.
Preparation now rejects a missing-but-locked version before archive/packing.

Each full metadata version list contained exactly `0.1.0-alpha.1`; both `next`
and `latest` pointed to it. The bounded, previously reviewed
[initial-alias policy](codex-bootstrap-latest.md) applies. This does not call
the alpha stable: an unqualified install of these new packages can select it.

## Trusted-publisher evidence

At 03:29 UTC the agent independently read all four configurations using
`npm@11.19.0 trust list --json`, without interactive authentication or mutation.
All four returned:

| Field | Value |
| --- | --- |
| type | github |
| repository | oai404iao/omp |
| file | publish.yml |
| environment | npm-publish |
| permissions | createPackage, createStagedPackage |

These permissions correspond to publish and stage publish. Only publish is needed
by this release workflow; the additional observed permission was disclosed and
left unchanged under the maintainer-approved PR scope. No cause for the extra
permission is inferred. Configuration evidence is not successful OIDC-publication
evidence. No auth token, OTP, authentication link or trust identifier is recorded.

## Earlier live-smoke evidence and limitations

The immutable source above was exercised using real prepared Codex tarballs in
a locked consumer on Node 24.13.0 / Pi 0.85.1. Synthetic SSE initial/follow-up
text, WS text and connection reuse, standalone search, and standalone image
generation returned the expected results. Six logical text executions, one
search and one image generation were performed under separate maintainer budget
authorizations. No further paid call is made by this activation.

The first WS harness missed actual frame accounting. A separately authorized
supplement observed exactly two frames on one connection; both used full context,
not `previous_response_id` delta. The supplement finished its responses but
timed out on process teardown: an incorrect harness shutdown session ID left a
five-minute idle timer. Correct-session cleanup was subsequently verified
offline against the real tarball, not by another paid run. Original failure
evidence was retained; this is not a claim of a clean original teardown.

No candidate package code was changed for those harness issues. This does not
verify other gateways/models, hosted tools, image editing/background jobs,
compaction, cancellation billing or delta continuation. Billing totals were not
independently verified. Gateway addresses and credentials are deliberately omitted.

## Remaining release gates

Review and merge this activation only after CI. Ordinary read-only preparation
must select four locked `recover` nodes from the bootstrap source and five new
`publish` candidates from the then-current reviewed main. Keep all nine on `next`,
respect exact dependency order and verify recoveries before consumers.

The maintainer must separately authorize `publish.yml` dispatch and approve
the protected `npm-publish` environment. Only clean final reconciliation may
create package tags/Releases. There is no permission here to republish the four
bootstrap versions, change existing stable tags or bypass a visibility failure.
