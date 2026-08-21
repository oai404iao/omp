# Third-party notices

## OpenAI Codex

This package includes and analyzes material from
[OpenAI Codex](https://github.com/openai/codex) at revision
[`eb9dceba1a2e658142a456c5898836774835616b`](https://github.com/openai/codex/commit/eb9dceba1a2e658142a456c5898836774835616b).

### Exact upstream snapshot

`src/providers/codex-apply-patch.lark` is an exact copy of:

```text
codex-rs/core/src/tools/handlers/apply_patch.lark
```

at the revision above. OpenAI Codex distributes that file under the Apache
License 2.0. The license and upstream NOTICE are included in:

- `LICENSES/Apache-2.0.txt`
- `LICENSES/OpenAI-Codex-NOTICE.txt`

### Modified compatibility implementation

`src/patch/parser.ts` and `src/patch/apply.ts` are substantially modified
TypeScript adaptations of the Codex apply-patch parsing and matching behavior
analyzed at revision
[`03bb3b12367397e14a8facc2e018d645ff4d8e83`](https://github.com/openai/codex/commit/03bb3b12367397e14a8facc2e018d645ff4d8e83).
The primary upstream paths were:

```text
codex-rs/apply-patch/src/parser.rs
codex-rs/apply-patch/src/streaming_parser.rs
codex-rs/apply-patch/src/seek_sequence.rs
codex-rs/apply-patch/src/lib.rs
codex-rs/core/src/tools/handlers/apply_patch.rs
codex-rs/core/src/tools/handlers/apply_patch_spec.rs
```

The local files were rewritten for TypeScript and Pi, including virtual-state
preflight, symlink and overwrite checks, mutation serialization, rollback,
CRLF preservation, and renderer preview integration. They carry prominent
source and modification notices and remain subject to the included
Apache-2.0 terms for the adapted material.

### Derived analysis

The repository's `reference/` directory contains protocol analysis based on
both Codex revisions above. It is development documentation and is excluded
from the npm tarball.

### Modified namespace-tool compatibility serialization

`src/codex-reserved-tools.ts` is a modified TypeScript compatibility
serialization of the Codex namespace-tool construction at the pinned revision
above. It preserves the local `web.run` and `image_gen.imagegen` declaration
shapes used by this package's internal Responses Lite path; it is not an exact
copy of one upstream file or an OpenAI-supported public API contract.

The two local function descriptions are byte-for-byte matches for:

```text
codex-rs/ext/web-search/web_run_description.md
codex-rs/ext/image-generation/imagegen_description.md
```

The local `web.run` parameters are a compatibility serialization derived from
the web-search schema generator and `SearchCommands` input types in:

```text
codex-rs/ext/web-search/src/tool.rs
codex-rs/ext/web-search/src/schema.rs
codex-rs/codex-api/src/search.rs
```

The local `image_gen.imagegen` parameters are a compatibility serialization
derived from `ImagegenArgs` and its namespace-tool construction in:

```text
codex-rs/ext/image-generation/src/lib.rs
codex-rs/ext/image-generation/src/tool.rs
```

`codex-rs/tools/src/responses_api.rs`,
`codex-rs/tools/src/tool_spec.rs`, and `codex-rs/core/src/client.rs` establish
the namespace serialization and Responses Lite tool placement. The immutable
upstream blob IDs, SHA-256 checksums, source URLs, and local canonical-JSON
fingerprints are recorded in
`provenance/openai-codex-eb9dceba-reserved-tools.json`.

The Apache-2.0 license and upstream NOTICE above apply to the derived material.
This source-attribution record resolves the earlier captured-metadata
classification at the engineering level; it is not legal advice. This `1.3.0`
source revision is approved only for a one-time manual npm bootstrap from a
reviewed public `main` commit. It is intentionally excluded from guarded
GitHub Actions release artifacts until the npm trusted publisher is configured
and a separate reviewed activation changes its release track to `publishable`.
