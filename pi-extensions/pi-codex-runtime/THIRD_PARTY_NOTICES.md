# Source and license notices

The original four `openai` GPT-6 profiles use independently checked metadata
from MIT-licensed Pi 0.99.1 (`d86654abb8862e201933517d6f1fce9f88dd117f`).
`provenance/pi-openai-0991-gpt6.json` pins the generator and shipped catalog.
The profiles select Standard/local capabilities; they do not copy model
instructions, replace Pi descriptors or infer remote endpoint entitlement.

The Pi 1.2.0 SDK catalog and public sampling helper are checked at MIT-licensed
revision `06a466935536f8c9bcacb2d5efc0fc021be1bdff`.
`provenance/pi-openai-120-gpt6.json` records exact source and catalog hashes;
the four selected chat descriptors are unchanged from the original evidence.

The historical Pi 1.4.0 catalog is checked at MIT-licensed revision
`4a080252f06caf63a525d7873c5d94d3c23887e0`.
`provenance/pi-openai-140-gpt6.json` pins its exact catalog and descriptor hashes.
The four selected descriptors add only `compat.supportsMidConvoEffort`.

The installed Pi 1.5.2 catalog is checked at MIT-licensed revision
`b4afdddf44e059c67ccf5097e5317d913521b470`. `provenance/pi-openai-152-gpt6.json`
pins the registry archive integrity and exact catalog and descriptor hashes.

Append-only effort-history serialization follows Apache-2.0 Codex revision
`0585dcb5dbb276a78909fa8fd0b36310f16973f9` and MIT Pi 1.5.0 revision
`f9a26365568127461c47a07a37dcb42c140a3ac5`.
`provenance/openai-codex-0585dcb-effort-updates.json` records exact sources.
The local converter reconstructs only same-model provider-effort annotations
and suppresses unchanged updates; it does not copy a process-global pin or
infer model support from names.

Sol/Luna profile metadata was independently checked against Apache-2.0 Codex
revision `40eac3ce8a0c10cbcb9db910d529355eb2f8fc09` and the MIT Pi 0.87.1
catalog. See `provenance/openai-codex-40eac3ce-sol-luna.json` for exact source
hashes and limits. The local catalog adapts those capabilities; it does not
copy model instructions, enable unverified billing multipliers or imply access.

This package owns shared code split from `@oai404iao/pi-codex-minimal-tools`.
Project material remains Copyright (c) 2026 oai404iao. The composite LICENSE
and verified Apache license/NOTICE snapshots are retained.

Historical Codex protocol evidence remains pinned to
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

Current standalone declaration evidence is recorded in
`provenance/openai-codex-a1604a8c-tool-declarations.json` for Apache-2.0 Codex
revision `a1604a8c0554c09c1be45e5a121bb1889b4d9a50`. The web description and
default serialized parameters match upstream; the image description and
parameters adapt upstream guidance and count bounds to Pi's paths, `read`,
and codemode. Earlier reserved-tool and image evidence is retained unchanged.

Current request metadata, model verbosity/reasoning defaults, search-history
projection and bounded HTTP retry behavior are adapted from Apache-2.0 Codex
revision `5a3140176e668a2f72f3c098490eb7f7052d9d85`.
`provenance/openai-codex-5a314017-wire-alignment.json` records verified upstream
blob IDs, SHA-256 hashes, exact model defaults and local adaptation boundaries.
Pi retains its model descriptors and reviewed transport policy; no upstream
model instructions, authentication claims or unavailable telemetry are copied.

See `reference/source-map.md` for the pinned evidence map and
`reference/legacy-source-notices.md` for the historical bundle attribution.
Provenance `localPaths` retain their original snapshot names even when a path
has since moved to its owner package.
