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
- `src/codex-reserved-tools.ts` contains tool descriptions and schemas
  captured from the Responses Lite `additional_tools` output emitted by
  Codex CLI 0.146.0 for `gpt-5.6-sol`.

OpenAI Codex is distributed under the Apache License 2.0. The verified license
and upstream NOTICE are identical at both analyzed revisions and are
preserved in:

- `LICENSES/Apache-2.0.txt`
- `LICENSES/OpenAI-Codex-NOTICE.txt`

The exact provenance and redistribution terms of any service-emitted or
server-supplied portions of `src/codex-reserved-tools.ts` have not yet been
confirmed. The package remains private and excluded from npm publication
until that review is complete.

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

## Unresolved design provenance

`pi-extensions/pi-subagent/README.md` says its design adapts a "DeepSeek
Harness subagent seam", but the original repository, revision, and license
were not recorded in Git history. No copied source file has been identified;
the package nevertheless remains private until that reference is clarified.
