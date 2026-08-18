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

### Captured tool metadata — review incomplete

`src/codex-reserved-tools.ts` contains tool descriptions and JSON schemas
captured from the Responses Lite `additional_tools` output emitted by Codex
CLI 0.146.0 for `gpt-5.6-sol`.

The exact provenance and redistribution terms of service-emitted or
server-supplied portions have not yet been confirmed. This package remains
private and must not be published to npm until that review is resolved.
