# Initial Codex bootstrap tag correction

## Observed issue

The runtime's initial `0.1.0-alpha.1` is visible on the public registry with
gitHead `32ba01f3c08b7fd63d09e9b2373cf081c4525533` and a SHA-512 integrity matching
the reviewed tarball. Its only published version has both `next` and `latest`.
The maintainer's attempt to remove `latest` returned E400.

Earlier npm CLI metadata queries returned E404 while a direct public-registry
query succeeded; subsequent CLI queries succeeded too. That transient lookup
failure was not evidence of a failed publish, and its precise cache/propagation
cause was not established.

The helper and guarded publisher wrongly treated any prerelease/latest alias
as an error even for a new package with no stable version.
[npm's registry schema](https://github.com/npm/registry/blob/main/docs/REGISTRY-API.md#package)
defines package dist-tags as including `latest`. Repeated authentication or
deleting the required tag is not the appropriate remedy.

## Explicitly approved correction

The maintainer approved correction of the local verifier and a separate
publisher PR, without package publication or tag mutation.

The shared pure predicate permits only:

- the four new Codex package names, not the compatibility bundle or subagent;
- initial version `0.1.0-alpha.1` and reviewed source `32ba01f3…`;
- correct `next`, with `latest` aliasing that same version;
- a successfully read version list containing exactly that version.

Both callers retain identity/integrity verification. The formal publisher
additionally requires `mode: recover` and an existing matching release-lock
entry; bootstrap eligibility and activation are unchanged. It checks tags before
dependent publication as well as during final tag/Release reconciliation.
No actual release-lock entries are fabricated by this correction.

This is an acknowledged initial alpha alias, not stable-release acceptance.
Unqualified installs of the new packages can select the alpha. Existing stable
packages and any later-version alias outside this initial exception remain
subject to the original rejection rule.

## Verification scope

Before the fix, the real-publisher fixture rejected the legitimate first
bootstrap recovery and allowed downstream writes before noticing bad tags.
The new regressions cover both behaviors, plus missing locks, wrong source,
wrong next, later alpha, other packages and invalid/additional version history.
Pure tests cover all four approved names and reject incomplete metadata.

The local verifier was updated without changing the artifact worktree's HEAD,
tarballs or manifests. Its read-only `after runtime` and `before core` checks
passed against the real registry.

No package payload, version, SDK, license/provenance snapshot, workflow
permission, release-lock record or registry tag is changed here. Further
bootstrap and activation remain separate maintainer operations.
