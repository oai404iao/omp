# Custom-tool streaming, parsing, and history replay

Custom/freeform apply patch changes both halves of the provider contract. The
tool declaration is only the first half; Codex also has dedicated stream,
router, executor, and replay paths for custom calls.

## End-to-end flow

```text
Responses SSE/WebSocket event
        │
        ▼
codex-api: normalize raw event into ResponseEvent
        │
        ├─ OutputItemAdded(CustomToolCall)
        │      └─ create apply_patch argument-diff consumer
        │
        ├─ ToolCallInputDelta
        │      └─ incrementally parse raw patch and emit patch previews
        │
        └─ OutputItemDone(CustomToolCall)
               ├─ finish diff consumer
               ├─ ToolRouter -> ToolPayload::Custom { input }
               ├─ parse, verify, approve, execute
               └─ CustomToolCallOutput added to next input
```

## Wire events

The key streaming event for freeform tool input is:

```json
{
  "type": "response.custom_tool_call_input.delta",
  "item_id": "ctc_...",
  "call_id": "call_...",
  "delta": "*** Begin Patch\n..."
}
```

Codex normalizes it to:

```text
ResponseEvent::ToolCallInputDelta {
    item_id,
    call_id,
    delta
}
```

The completed item arrives through `response.output_item.done` and is
deserialized as `ResponseItem::CustomToolCall` with `call_id`, `name`, and the
complete raw `input` string.

This differs from a JSON function call, whose argument stream uses
`response.function_call_arguments.delta` or equivalent function events and
whose completed `arguments` field is JSON text.

## Incremental patch parser

When an output item is added, the session loop checks whether it is a custom
tool call. It resolves the tool name and asks the tool registry for a
`ToolArgumentDiffConsumer`. `apply_patch` supplies one backed by
`StreamingPatchParser`.

For each raw input delta the consumer:

1. Feeds characters into a line buffer.
2. Advances parser state when a newline completes a line.
3. Maintains parsed add, delete, and update hunks.
4. Converts current hunks to protocol `FileChange` values.
5. Emits throttled `PatchApplyUpdated` events for the UI.

The preview parser is not the executor. On completed output Codex finishes the
streaming parser, then the handler reparses and verifies the complete patch
before any filesystem mutation.

Malformed preview deltas generally suppress an incremental preview; malformed
final input becomes a tool-facing verification error. The handler uses errors
such as:

```text
apply_patch verification failed: ...
```

Filesystem/context failures may include messages such as:

```text
Failed to find expected lines in ...
Failed to find context ...
```

### Pi filesystem preview

This extension maps the same lifecycle onto Pi's tool-call renderer. Partial
function or custom arguments are accumulated as `{input}`; the renderer parses
only newline-terminated input and evaluates the valid prefix against the local
cwd. It emits no synthetic tool execution and performs no writes. Reads are
throttled to at most once every 500 ms, and pending/in-flight preview results
are discarded once actual execution starts.

There is no Codex sandbox object in Pi. The preview uses the local filesystem
and the executor's path, realpath, symlink, overwrite, virtual-state, queue,
snapshot, and rollback rules. Final execution still reparses the complete
patch and is authoritative.

## Router representation

Codex preserves the distinction between function and custom tools in its
internal payload:

```text
FunctionCall    -> ToolPayload::Function { arguments }
CustomToolCall  -> ToolPayload::Custom { input }
```

The apply-patch handler's runtime matcher accepts only `ToolPayload::Custom`.
This prevents an accidental function call with similarly named JSON arguments
from silently entering the freeform handler.

Frameworks whose generic tool interface requires an argument object can bridge
the raw patch internally, for example as `{ input: rawPatch }`. That bridge is
an internal execution representation; it must not erase the custom wire type.

## Tool result routing

Codex chooses the output item from the original payload kind:

```text
ToolPayload::Custom   -> custom_tool_call_output
all other tool kinds  -> function_call_output or their dedicated output type
```

For a text-only apply-patch result, the next request contains:

```json
{
  "type": "custom_tool_call_output",
  "call_id": "call_...",
  "output": "Success. Updated the following files:\nM src/a.ts"
}
```

Returning `function_call_output` for a `custom_tool_call` violates the call
contract even if `call_id` is unchanged.

## History replay

A stateless or full-context next turn must replay both items in their original
wire forms:

```json
{
  "type": "custom_tool_call",
  "call_id": "call_...",
  "name": "apply_patch",
  "input": "*** Begin Patch\n...\n*** End Patch\n"
}
```

```json
{
  "type": "custom_tool_call_output",
  "call_id": "call_...",
  "output": "Success. Updated the following files:\nM src/a.ts"
}
```

An adapter therefore needs to retain or reliably reconstruct at least:

- tool name;
- call ID;
- custom versus function wire kind;
- complete raw patch input;
- output text or structured content.

Inferring custom kind only from the current model is fragile when a session
switches providers or transports. Persisting provider-specific call metadata
is the robust design. If the host type cannot carry metadata, the adapter must
maintain a call-ID mapping and define behavior for model/provider handoff.

## WebSocket continuation

Codex can compress a WebSocket request using `previous_response_id` and only
the newly appended input items. It does so only if the previous logical input
is an exact prefix and all context-affecting request fields match.

This matters for custom tools because a follow-up request may contain only the
new `custom_tool_call_output`; the corresponding call can live in the server's
previous response. A request hook that discovers custom calls only by scanning
the current delta cannot safely rewrite that output without retained state.

## Minimum parser state for an adapter

A custom-aware Responses parser needs per-output-item state similar to:

```ts
type OutputSlot =
  | { kind: "text"; text: string }
  | { kind: "reasoning"; text: string }
  | { kind: "function"; callId: string; name: string; arguments: string }
  | { kind: "custom"; callId: string; name: string; input: string };
```

Required transitions are:

1. Create the custom slot on `response.output_item.added`.
2. Append raw text on `response.custom_tool_call_input.delta`.
3. Reconcile with the authoritative complete item on
   `response.output_item.done`.
4. Emit one internal tool call carrying the complete raw input.
5. Preserve custom kind for result serialization and history replay.

SSE and WebSocket must share this normalization and state machine. Supporting
the event in only one transport creates mode-dependent conversation failures.

## Codex sources

- `codex-rs/codex-api/src/sse/responses.rs`
- `codex-rs/core/src/session/turn.rs`
- `codex-rs/apply-patch/src/streaming_parser.rs`
- `codex-rs/core/src/tools/handlers/apply_patch.rs`
- `codex-rs/core/src/tools/router.rs`
- `codex-rs/core/src/tools/context.rs`
- `codex-rs/protocol/src/models.rs`
- `codex-rs/codex-api/src/endpoint/responses_websocket.rs`