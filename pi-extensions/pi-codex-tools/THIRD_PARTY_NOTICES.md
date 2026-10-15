# Source and license notices

This package owns tools physically moved from `pi-codex-core`,
`pi-codex-web-search` and `pi-codex-imagegen`. Project material remains
Copyright (c) 2026 oai404iao. The composite LICENSE and verified Apache-2.0
license/NOTICE snapshots are retained.

Codex protocol evidence remains pinned to
`eb9dceba1a2e658142a456c5898836774835616b`; apply-patch execution compatibility
remains pinned to `03bb3b12367397e14a8facc2e018d645ff4d8e83`.
Immutable provenance paths describe the original source snapshot, not current
package ownership.

`src/providers/codex-apply-patch.lark` is an exact copy of
`codex-rs/core/src/tools/handlers/apply_patch.lark` at the protocol revision.
The substantially modified TypeScript parser/executor in `src/patch/` adapts
`codex-rs/apply-patch/src/{parser,streaming_parser,seek_sequence,lib}.rs` and core
handlers at the execution revision. Local changes include virtual-state
preflight, symlink/overwrite checks, serialized mutation, rollback, CRLF
preservation and preview integration. Source modification notices and the
included Apache-2.0 terms and upstream NOTICE apply to that material.

Search/image clients and presentation are project implementations. Runtime owns
the canonical namespace schemas and evidence. Image request behavior follows
Codex `5a3140176e668a2f72f3c098490eb7f7052d9d85`, with hashes recorded in runtime's
`provenance/openai-codex-5a314017-image-generation.json`.

Reference-image normalization uses separately distributed Apache-2.0
`@silvia-odwyer/photon-node` 0.3.4. Its package includes its own license; no Photon
source or WASM binary is vendored here.
