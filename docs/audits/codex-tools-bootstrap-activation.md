# Codex tools bootstrap activation

## Scope and authority

The maintainer performed tools' first publication locally, then requested
GitHub Actions publishing support. This separate activation changes only tools'
release eligibility from `bootstrap` to `publishable`, records its verified
immutable artifact, and permits its exact initial tag/history combination.
Package versions, package payloads and exact workspace pins are unchanged.
Historical lock entries and the original four-package bootstrap rule remain
unchanged. No changeset is needed for this infrastructure-only change.

The agent configured this package's npm trusted publisher under that request.
No package was published, unpublished, promoted, or republished by the agent.
Any tools workflow run at the existing version must be recovery-only.
Compatibility consumers and minimal-tools require separate protected dispatch;
minimal-tools remains last.

## Public registry evidence — 2026-10-15

At 10:25 UTC anonymous canonical npm package metadata and exact-version reads
confirmed:

| Field | Value |
| --- | --- |
| name | `@oai404iao/pi-codex-tools` |
| version | `0.1.0-alpha.1` |
| gitHead | `b9deaba6ba07d87c048e474b2ddc977f3bd2b442` |
| tarball bytes | 47,543 |
| next | `0.1.0-alpha.1` |
| latest | `0.1.0-alpha.1` |
| complete version history | `0.0.0-stage`, `0.1.0-alpha.1` |

The downloaded public alpha tarball's computed SHA-512 matched metadata and
[the newly appended immutable lock](../../release-locks/npm-published-artifacts.json).
It also matched the exact reviewed local bootstrap artifact byte-for-byte.
The source is public main after PR #101; no package payload changed in that PR.

The earlier package lookup returned 404; subsequent reads succeeded. No
resubmission was performed to address that temporary visibility failure.

### Observed staging placeholder

The metadata marks `0.0.0-stage` as `stub:true` with description
`Temporary package placeholder for staged publishing`. Its downloaded tarball
is 374 bytes, with computed SHA-512 matching registry metadata:

```text
sha512-if1oPoHElJNHZ8nH+0jVh7o+VHPFFHn9jGQLWLAdtuRg1quVlbsBtBw2AuoPG0wiDzLJx+1Hedzr2No/tjyeww==
```

npm documents this version as its placeholder when staging a previously
nonexistent package:
[official staged-publishing documentation](https://docs.npmjs.com/staged-publishing/).
It is not a second tools implementation release. No user/client action that
created or approved the stage is inferred from this observation.

The new tools alias exception requires the exact alpha source/version,
`latest=next=0.1.0-alpha.1`, and exactly this two-version history. It is not
a generic exemption for `0.0.0-stage`, other packages, extra versions, or later
tools versions. The guarded publisher additionally requires recovery mode and
the matching alpha release-lock source/integrity. Existing four-package
exceptions still require their original source and exactly one version.

## Trusted publisher and GitHub protection

`npm@11.19.0 trust github` configured only this package with the explicit
`--allow-publish` permission and exact repository/workflow/environment fields.
A separate `trust list --json` readback confirmed:

| Field | Value |
| --- | --- |
| type | `github` |
| repository | `oai404iao/omp` |
| file | `publish.yml` |
| environment | `npm-publish` |
| observed permissions | `createPackage`, `createStagedPackage` |

npm also grants staged publishing; no dist-tag management permission was
requested. No credentials, authentication links, OTPs or trust identifiers
are retained in this repository.

Read-only GitHub API checks confirmed the existing `npm-publish` environment
requires a maintainer reviewer, restricts deployment to protected branches,
and has `NPM_PUBLISH_ENABLED=true`. The existing workflow still restricts runs
to `main`, requires manual dispatch and `confirm=publish`, and grants OIDC only
to the protected publish job. No automatic push publication or npm token was
introduced.

Configuration readback and recovery do not prove an actual OIDC publication.
Per [npm's trusted-publisher expiry rules](https://docs.npmjs.com/trusted-publishers/#trusted-publisher-configuration-expiry),
a new configuration must complete its first successful publish within two days
or be recreated. Do not invent or overwrite a version merely to validate it;
a separately authorized future release must supply that end-to-end evidence.
