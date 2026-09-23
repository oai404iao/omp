# Source and license notices

Sol/Luna metadata and reasoning mappings were checked against Apache-2.0 Codex
revision `40eac3ce8a0c10cbcb9db910d529355eb2f8fc09` and the MIT Pi 0.87.1
catalog. See `provenance/openai-codex-40eac3ce-sol-luna.json`. Request adaptation
uses Pi's Off mapping; it does not add public-API TTL fields to Codex Lite.

This unpublished package is split from `@oai404iao/pi-codex-minimal-tools`.
Project material remains Copyright (c) 2026 oai404iao. The composite LICENSE
and verified Apache license/NOTICE snapshots are retained.

Codex protocol evidence remains pinned to
`eb9dceba1a2e658142a456c5898836774835616b`;
apply-patch compatibility evidence remains pinned to
`03bb3b12367397e14a8facc2e018d645ff4d8e83`.
The unmodified provenance record preserves upstream source identifiers, not
claims that every referenced source file is shipped in this package.

The `openai-codex/gpt-6-astra` Lite behavior is derived from Codex
model/request metadata at
`ddea03ad049142943bdbf13e937b1d67e8c1ba0c`, cross-checked against the
MIT-licensed `@earendil-works/pi-ai@0.85.1` catalog. Exact source and tarball
identifiers are recorded in
`provenance/openai-codex-ddea03ad-astra.json`.

The substantially modified TypeScript apply-patch adaptations and grammar are
under `src/patch/` and `src/providers/`; retain their source modification notices.
The internal Responses Lite transport is an unsupported compatibility boundary.

See the original package's reference/source-map.md for the pinned evidence map.
