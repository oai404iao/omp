# Apply-patch behavior

This extension's local executor follows the patch parsing and matching behavior
of the analyzed Codex checkout at commit
`03bb3b12367397e14a8facc2e018d645ff4d8e83`. The wire transport remains a
separate concern: both the JSON function fallback and the Codex freeform custom
tool bridge the patch text into the same local executor.

The broader protocol reference was revalidated at
`eb9dceba1a2e658142a456c5898836774835616b`. Codex's apply-patch executor was
substantially refactored between those snapshots, so this document deliberately
describes the extension's implemented compatibility baseline rather than
claiming byte-for-byte parity with the newer executor.

## Canonical patch structure

A patch contains one or more Add, Update, or Delete sections between
`*** Begin Patch` and `*** End Patch`.

- Add content must contain one or more `+` lines and is written with a trailing
  newline.
- Delete contains only its file header.
- Update contains one or more chunks. A chunk may start with `@@` or
  `@@ <context>`, and may end with `*** End of File`.
- `*** Move to: <path>` is accepted only immediately after an Update header.
- File paths are interpreted literally. Shell quoting, an `@` prefix, heredoc
  wrappers, and the unified-diff `\ No newline at end of file` marker are not
  part of this tool's patch language.

The packaged custom-tool grammar is
[`src/providers/codex-apply-patch.lark`](../src/providers/codex-apply-patch.lark).

## Update matching

Update chunks are located in order using a forward-only cursor. An `@@
<context>` line first moves that cursor past the matching class, function, or
other context line. The chunk's old lines are then matched with decreasing
strictness:

1. exact lines;
2. lines with trailing whitespace ignored;
3. lines with leading and trailing whitespace ignored;
4. lines with common Unicode dashes, quotes, and spaces normalized to ASCII.

`*** End of File` requires the old lines to match at the end of the file. A
chunk containing only additions appends them to the file, matching Codex's
executor behavior. Replacements are computed first and applied from the end of
the file backwards so earlier edits do not shift later indexes.

The executor preserves a CRLF file's line-ending style. Add files use LF. Like
the analyzed Codex executor, Add and non-empty Update results end with a
newline.

## Verification and mutation safety

All actions are resolved and evaluated against a virtual file state before the
first filesystem mutation. This allows multiple ordered actions against the
same path while preventing a later context error from leaving earlier actions
on disk.

The following are intentional Pi safety differences from the analyzed Codex
runtime:

- a final symbolic link is not mutated;
- Add refuses to overwrite an existing target;
- Move refuses to overwrite an existing destination;
- touched paths are serialized through Pi's file-mutation queue;
- an I/O failure during commit triggers best-effort rollback of every touched
  file, including restoration of file mode bits.

Relative paths resolve against the active cwd, but `..` traversal, absolute
paths, and paths through symbolic-link ancestors are accepted. This extension
does not enforce a workspace boundary; users who need one should provide it
through Pi permissions, sandboxing, or another extension.

Codex relies on its sandbox, approval runtime, and committed-delta tracking for
the remaining safety concerns, so copying its overwrite and partial-commit
behavior would not provide equivalent safety inside Pi.

## Tool output

Successful application uses the Codex summary format and preserves action
order:

```text
Success. Updated the following files:
A src/new.ts
M src/existing.ts
M src/renamed.ts
D src/old.ts
```

For Move, the `M` line displays the destination path. Structured result details
continue to include source and destination paths for renderers and callers.

## Streaming filesystem preview

The built-in renderer parses newline-terminated patch input while either the
custom/freeform or JSON function call is still streaming. It evaluates the
currently valid action prefix against the active cwd using the same virtual
filesystem planning logic as final execution, then displays A/M/D paths, Move
destinations, and old/new line counts.

Preview work is read-only and throttled to at most once every 500 ms. A newer
delta supersedes an older pending preview. Once Pi reports that tool execution
has started, delayed preview work is cancelled and in-flight results are
ignored so they cannot race with mutations. The completed tool call is always
reparsed by `parseApplyPatch()` and remains authoritative.

Pi does not expose Codex's sandbox and permission runtime. Preview and final
verification therefore use the local filesystem plus this extension's
final-target symlink, overwrite, mutation-queue, snapshot, and rollback checks.
Set `deferApplyPatchRendering: true` to disable the built-in preview and use
Pi's fallback renderer.

## Primary Codex sources

- `codex-rs/apply-patch/src/parser.rs`
- `codex-rs/apply-patch/src/streaming_parser.rs`
- `codex-rs/apply-patch/src/seek_sequence.rs`
- `codex-rs/apply-patch/src/lib.rs`
- `codex-rs/core/src/tools/handlers/apply_patch.rs`
- `codex-rs/core/src/tools/handlers/apply_patch_spec.rs`
