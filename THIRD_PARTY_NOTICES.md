# Third-party notices

The root [MIT license](LICENSE) covers project-authored material. The
following components retain their own licenses and attribution.

## OpenAI Codex

`pi-extensions/pi-codex-minimal-tools` includes material from
[OpenAI Codex](https://github.com/openai/codex), analyzed at revision
[`eb9dceba1a2e658142a456c5898836774835616b`](https://github.com/openai/codex/commit/eb9dceba1a2e658142a456c5898836774835616b).

- `src/providers/codex-apply-patch.lark` is an exact snapshot of
  `codex-rs/core/src/tools/handlers/apply_patch.lark` at that revision.
- `src/patch/parser.ts` and `src/patch/apply.ts` are substantially modified
  TypeScript adaptations of the apply-patch parsing and matching behavior
  analyzed at
  [`03bb3b12367397e14a8facc2e018d645ff4d8e83`](https://github.com/openai/codex/commit/03bb3b12367397e14a8facc2e018d645ff4d8e83).
- The package's `reference/` documentation contains protocol analysis based
  on both revisions, as recorded in `reference/source-map.md` and
  `reference/apply-patch-behavior.md`.
- `src/codex-reserved-tools.ts` is a modified TypeScript compatibility
  serialization of the pinned Codex `web.run` and
  `image_gen.imagegen` namespace-tool construction. Its two descriptions
  exactly match the upstream Markdown sources; its parameter declarations are
  source-derived compatibility serializations of the pinned schema types and
  generators. Immutable source/blob IDs, SHA-256 checksums, source URLs, and
  local fingerprints are recorded in
  `pi-extensions/pi-codex-minimal-tools/provenance/openai-codex-eb9dceba-reserved-tools.json`.

OpenAI Codex is distributed under the Apache License 2.0. The verified license
and upstream NOTICE are identical at both analyzed revisions and are
preserved in:

- `LICENSES/Apache-2.0.txt`
- `LICENSES/OpenAI-Codex-NOTICE.txt`

The package-level source-attribution record replaces its earlier
captured-metadata classification at the engineering level; it is not legal
advice. `pi-codex-minimal-tools@1.3.0` is staged only for a one-time manual
npm bootstrap from a reviewed public `main` commit. It remains excluded from
guarded GitHub Actions release artifacts until trusted publishing is configured
and a dedicated activation moves it to the publishable track. Its Responses
Lite path is an internal Codex compatibility layer, not an OpenAI-supported
public API contract.

## oh-my-pi

`pi-extensions/external-thinking` is a modified port of the
`externalThinking` feature from
[`can1357/oh-my-pi`](https://github.com/can1357/oh-my-pi).

- Feature introduction:
  [`10fd42289c3a7dab9db803175e4e4db8321b93a2`](https://github.com/can1357/oh-my-pi/commit/10fd42289c3a7dab9db803175e4e4db8321b93a2)
- Reference snapshot immediately preceding the local port:
  [`848f7fb0fd45b6f7a01a66e4b26ab568251a13a0`](https://github.com/can1357/oh-my-pi/commit/848f7fb0fd45b6f7a01a66e4b26ab568251a13a0)

oh-my-pi is distributed under the MIT License:

```text
Copyright (c) 2025 Mario Zechner
Copyright (c) 2025-2026 Can Bölük
```

The verified upstream license is preserved in
`LICENSES/oh-my-pi-MIT.txt`. The port's package-level `LICENSE` retains those
notices and adds the local modification copyright.

## DeepSeek Harness design reference

`pi-extensions/pi-subagent` independently implements Pi extension and SDK
integration while adapting high-level subagent design concepts from the public
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
documentation at revision
[`4d03472cd098dc48a630e526ca620f4f37f18a0e`](https://github.com/deepseek-ai/deepseek-harness/commit/4d03472cd098dc48a630e526ca620f4f37f18a0e).

DeepSeek Harness is MIT-licensed. Its verified license snapshot is preserved
at `LICENSES/DeepSeek-Harness-MIT.txt` and in the package's
`LICENSES/DeepSeek-Harness-MIT.txt`. No DeepSeek Harness source file is
included in the package; its immutable source revision, blob identifiers, and
SHA-256 checksums are recorded in
`pi-extensions/pi-subagent/provenance/deepseek-harness-4d03472.json`. See its
package-level `THIRD_PARTY_NOTICES.md` for the implementation boundary.
