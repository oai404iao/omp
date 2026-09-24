# Source and license notices

Sol/Luna profile metadata was independently checked against Apache-2.0 Codex
revision `40eac3ce8a0c10cbcb9db910d529355eb2f8fc09` and the MIT Pi 0.87.1
catalog. See `provenance/openai-codex-40eac3ce-sol-luna.json` for exact source
hashes and limits. The local catalog adapts those capabilities; it does not
copy model instructions, enable unverified billing multipliers or imply access.

This package owns shared code split from `@oai404iao/pi-codex-minimal-tools`.
Project material remains Copyright (c) 2026 oai404iao. The composite LICENSE
and verified Apache license/NOTICE snapshots are retained.

Codex protocol evidence remains pinned to
`eb9dceba1a2e658142a456c5898836774835616b`;
apply-patch compatibility evidence remains pinned to
`03bb3b12367397e14a8facc2e018d645ff4d8e83`.
The unmodified provenance record preserves upstream source identifiers, not
claims that every referenced source file is shipped in this package.

The bundled `openai-codex/gpt-6-astra` profile is derived from Codex model and
request metadata at
`ddea03ad049142943bdbf13e937b1d67e8c1ba0c`, cross-checked against the
MIT-licensed `@earendil-works/pi-ai@0.85.1` catalog. Exact source and tarball
identifiers are recorded in
`provenance/openai-codex-ddea03ad-astra.json`.

Modified namespace-tool compatibility serialization is in
`src/codex-reserved-tools.ts` and the capability-specific `src/reserved-tools/`
assets. This is not a license or authorization to access
private endpoints; the internal Responses Lite path remains unsupported upstream.

The descriptions match the pinned Codex `web_run_description.md` and
`imagegen_description.md`; the parameter schemas are derived compatibility
serializations, not verbatim source copies. Exact upstream paths, hashes and
canonical-JSON fingerprints are in the reserved-tools provenance record.

See `reference/source-map.md` for the pinned evidence map and
`reference/legacy-source-notices.md` for the historical bundle attribution.
Provenance `localPaths` retain their original snapshot names even when a path
has since moved to its owner package.
