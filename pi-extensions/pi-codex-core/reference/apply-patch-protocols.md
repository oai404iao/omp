# Apply-patch wire protocols

There are three distinct Responses wire contracts commonly called
`apply_patch`. They share a purpose but are not interchangeable.

## 1. Codex freeform custom tool

The analyzed Codex CLI constructs `apply_patch` as a `ToolSpec::Freeform`.
`ToolSpec` serializes that variant with `type:"custom"`:

```json
{
  "type": "custom",
  "name": "apply_patch",
  "description": "Use the `apply_patch` tool to edit files. This is a FREEFORM tool, so do not wrap the patch in JSON.",
  "format": {
    "type": "grammar",
    "syntax": "lark",
    "definition": "<contents of codex-apply-patch.lark>"
  }
}
```

There is no JSON parameters schema and no `input` or `patchText` argument. The
model emits the complete patch directly as raw custom-tool input:

```json
{
  "type": "custom_tool_call",
  "id": "ctc_...",
  "call_id": "call_...",
  "name": "apply_patch",
  "input": "*** Begin Patch\n*** Update File: src/a.ts\n@@\n-old\n+new\n*** End Patch\n"
}
```

Codex maps this item to an internal custom payload:

```text
ToolPayload::Custom { input: raw_patch_text }
```

In current Responses Lite, this custom spec is a child of the default
`functions` namespace. Calls may therefore carry:

```json
{
  "type": "custom_tool_call",
  "namespace": "functions",
  "name": "apply_patch",
  "input": "*** Begin Patch\n..."
}
```

The namespace must be retained for full-context replay even if the host maps
the call to a flat local tool name.

The apply-patch handler only accepts that payload type. It parses the raw text,
verifies the resulting file changes against the selected filesystem and
sandbox, obtains any required approval, and dispatches the verified changes to
the apply-patch runtime.

The execution result is returned as a custom-tool output:

```json
{
  "type": "custom_tool_call_output",
  "call_id": "call_...",
  "output": "Success. Updated the following files:\nM src/a.ts"
}
```

`output` uses the same Codex payload abstraction as function output: it can be
plain text or structured content items. A simple text result serializes as a
string.

## Grammar

The analyzed grammar is:

```lark
start: begin_patch hunk+ end_patch
begin_patch: "*** Begin Patch" LF
end_patch: "*** End Patch" LF?

hunk: add_hunk | delete_hunk | update_hunk
add_hunk: "*** Add File: " filename LF add_line+
delete_hunk: "*** Delete File: " filename LF
update_hunk: "*** Update File: " filename LF change_move? change?

filename: /(.+)/
add_line: "+" /(.*)/ LF -> line

change_move: "*** Move to: " filename LF
change: (change_context | change_line)+ eof_line?
change_context: ("@@" | "@@ " /(.+)/) LF
change_line: ("+" | "-" | " ") /(.*)/ LF
eof_line: "*** End of File" LF

%import common.LF
```

In multi-environment mode Codex derives a second grammar by changing `start` so
an optional `*** Environment ID: ...` line may follow `*** Begin Patch`.

Important parser/runtime details:

- A patch contains one or more add, delete, or update hunks.
- `*** Move to:` belongs to an update hunk.
- `@@` can be empty or carry a context label.
- `*** End of File` is part of the accepted grammar.
- Grammar acceptance is only syntax validation. Codex still parses and verifies
  context, paths, sandbox access, and approvals locally.

The packaged provider resource
[`src/providers/codex-apply-patch.lark`](../src/providers/codex-apply-patch.lark)
is an exact snapshot of the analyzed source grammar.

## 2. Public built-in apply-patch tool

OpenAI also documents a Responses built-in tool declared as:

```json
{
  "type": "apply_patch"
}
```

That protocol returns `apply_patch_call` items with a structured `operation`
such as create, update, or delete, and expects an `apply_patch_call_output`.
This is a separate native protocol. It does not carry the complete Codex
multi-file patch as `custom_tool_call.input`.

The analyzed Codex CLI does not construct this built-in declaration and does
not parse `apply_patch_call` items. Therefore “OpenAI native apply_patch” and
“the protocol used by Codex CLI” must not be treated as synonyms.

## 3. JSON function fallbacks

Function-based implementations expose a JSON schema and receive a
`function_call`:

```json
{
  "type": "function",
  "name": "apply_patch",
  "parameters": {
    "type": "object",
    "properties": {
      "input": { "type": "string" }
    },
    "required": ["input"],
    "additionalProperties": false
  }
}
```

The complete patch is escaped inside the function `arguments` JSON string. The
current extension uses the field name `input`; the analyzed OpenCode checkout
uses `patchText`. Both are function protocols, not Codex freeform custom tools.

## Compatibility requirements

A freeform adaptation must change all of the following together:

1. Tool declaration from function to custom + grammar.
2. Stream parsing from function argument events to custom input events.
3. Internal representation from raw input to the executor's object argument,
   if the host framework requires an argument object.
4. Assistant history replay from `function_call` to `custom_tool_call`.
5. Tool-result replay from `function_call_output` to
   `custom_tool_call_output`.
6. Prompt text so it no longer tells the model to wrap the patch in an `input`
   JSON property.

Changing only the outbound `tools` array creates a half-compatible provider:
the model can emit a custom call that the stream parser and next turn cannot
understand.

## Codex sources

- `codex-rs/core/src/tools/handlers/apply_patch_spec.rs`
- `codex-rs/core/src/tools/handlers/apply_patch.lark`
- `codex-rs/tools/src/tool_spec.rs`
- `codex-rs/protocol/src/models.rs`
- `codex-rs/core/src/tools/router.rs`
- `codex-rs/core/src/tools/handlers/apply_patch.rs`
- `codex-rs/core/src/tools/context.rs`
