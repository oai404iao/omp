# Native mutation-tool projection

## Contract

Pi owns the selected tool set, including CLI/SDK allowlists and disabled tools.
The Codex runtime owns activation of installed package tools only. Core prefers
`apply_patch` by hiding selected `edit`/`write` declarations, not by changing
their selection.

The public `ToolDefinition.prepareLoadout` hook returns `hiddenDeclarations`.
Pi retains hidden tools in its active/callable sets and canonical transcript,
but projects their declarations out of model requests. The hook runs
only while its owning patch tool is active. Removing that tool therefore reveals
the selected native declarations without restoring plugin-owned state.

References: [Pi extensions](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md)
and `ToolLoadoutChanges` in Pi's exported extension types. The implementation
uses the repository's Pi 0.99.1 public API, also present in installed Pi 1.0.4.
Pi 1.0.4 also omits hidden tools from its default prompt; Pi 0.99.1 may retain
their prompt snippets and guidelines. Neither version deactivates the tools.

## Integration

- Remove physical native-tool suppression and in-memory restoration receipts.
- Hide only selected native mutation-tool names from the patch definition.
- Use the same owned-patch projection for prewarm and native-compaction tool
  snapshots. A foreign patch replacement must not alter native declarations.
- Keep existing codemode/tool-search projection handling. Native tools remain
  callable from codemode while hidden from direct model declarations.
- Leave provider compatibility, transport selection and proxy settings unchanged.

## Historical sessions

An older transcript with missing native tools cannot prove whether the plugin
or the user removed them. Do not silently enable them, rewrite session history,
or derive permissions from current defaults. Start a new session with an explicit
tool selection when an older session lacks the desired editing tools.

## Verification

Real SDK regressions compare request declarations with canonical transcript,
active and callable tools. They cover OpenAI/Claude switching, tree navigation,
reload and a fresh runtime restored from session entries, including partial and
empty native-tool selections. Snapshot tests cover owned, inactive and foreign
patch tools; existing protocol and package-install checks remain required.
