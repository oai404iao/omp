# Source and license notices

This package owns image code split from `@oai404iao/pi-codex-minimal-tools`.
Project material remains Copyright (c) 2026 oai404iao. The composite LICENSE
and verified Apache license/NOTICE snapshots are retained.

Codex protocol evidence remains pinned to
`eb9dceba1a2e658142a456c5898836774835616b`;
apply-patch compatibility evidence remains pinned to
`03bb3b12367397e14a8facc2e018d645ff4d8e83`.
The unmodified provenance record preserves upstream source identifiers, not
claims that every referenced source file is shipped in this package.

Image request behavior and the runtime-owned namespace declaration now follow
Codex `5a3140176e668a2f72f3c098490eb7f7052d9d85`, including transparent-background
requests. The runtime package ships the exact source and canonical-JSON hashes
in `provenance/openai-codex-5a314017-image-generation.json`.
The earlier provenance record remains historical evidence.

Endpoint clients and presentation code are project implementations. Protocol
shapes are consumed from pi-codex-runtime rather than copied here.

Reference image normalization uses the separately distributed
`@silvia-odwyer/photon-node` 0.3.4 dependency (Apache-2.0), retaining original
dimensions and transparency when encoding GIF/BMP input as PNG. Its package
includes its own license; no Photon source or WASM binary is vendored here.

See `pi-codex-runtime/reference/source-map.md` in the repository for the pinned
evidence map and `reference/configuration.md` there for image configuration.
