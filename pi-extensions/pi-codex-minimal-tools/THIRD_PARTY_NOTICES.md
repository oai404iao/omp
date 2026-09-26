# Dependency license notices

This MIT-licensed package only composes the Codex capability extensions and
re-exports the runtime's public `subagent-inline` API. It contains no copied
Codex grammar, schema, protocol implementation or provenance snapshot.

The dependencies retain their own composite licenses, Apache-2.0 license and
upstream NOTICE snapshots, source modification notices and pinned provenance:

- `@oai404iao/pi-codex-runtime`: schemas, model metadata and reserved-tool serialization.
- `@oai404iao/pi-codex-core`: Responses transport, apply-patch grammar and adaptations.
- `@oai404iao/pi-codex-web-search`: web-search client and presentation.
- `@oai404iao/pi-codex-imagegen`: image-generation client and presentation.

See each dependency's `LICENSE`, `LICENSES/`, `THIRD_PARTY_NOTICES.md` and
`provenance/`. Historical bundle source notices are preserved in the repository
at `pi-extensions/pi-codex-runtime/reference/legacy-source-notices.md`.
