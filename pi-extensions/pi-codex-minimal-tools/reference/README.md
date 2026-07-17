# Codex Responses protocol reference

This directory records the OpenAI Codex request modes, tool wire contracts, and
response parsing behavior examined while designing this extension. It is a
source-backed reference, not a statement that the current extension already
implements every behavior described here.

## Snapshot and scope

- Codex checkout: `openai/codex`
- Analyzed commit: `03bb3b12367397e14a8facc2e018d645ff4d8e83`
- Local analysis date: 2026-07-17
- Primary implementation: `codex-rs/`

Source paths in these documents are relative to that Codex checkout unless a
different repository is named. Model availability and internal protocol fields
can change after the analyzed commit.

## Reading order

1. [Apply-patch wire protocols](apply-patch-protocols.md) separates the public
   built-in tool, Codex freeform custom tool, and JSON function fallbacks.
2. [Apply-patch behavior](apply-patch-behavior.md) records the local parser,
   matching algorithm, result format, and intentional Pi safety differences.
3. [Standard Responses mode](responses-standard.md) records the normal Codex
   request envelope and prompt/tool placement.
4. [Responses Lite mode](responses-lite.md) records the internal Lite request
   transformation, headers, and restrictions.
5. [Streaming, parsing, and replay](streaming-parsing-and-replay.md) follows a
   custom tool call from SSE/WebSocket deltas through execution and the next
   request.
6. [Model modes and Code Mode](model-modes-and-code-mode.md) separates model
   capability, Responses transport mode, and model-visible tool exposure.
7. [Hosted web-search streaming and rendering](web-search-streaming-rendering.md)
   records the Responses item lifecycle and Codex begin/end TUI behavior.
8. [Source map](source-map.md) maps each conclusion to Codex source and tests.

The exact freeform patch grammar from the analyzed commit is also preserved as
the packaged provider resource
[`src/providers/codex-apply-patch.lark`](../src/providers/codex-apply-patch.lark).

## Protocol taxonomy

| Name in this reference | Tool declaration | Model call item | Result item | Used by analyzed Codex CLI |
| --- | --- | --- | --- | --- |
| Public built-in apply patch | `{"type":"apply_patch"}` | `apply_patch_call` | `apply_patch_call_output` | No |
| Codex freeform apply patch | `{"type":"custom","name":"apply_patch",...}` | `custom_tool_call` | `custom_tool_call_output` | Yes |
| JSON function fallback | `{"type":"function","name":"apply_patch",...}` | `function_call` | `function_call_output` | No |

The analyzed Codex CLI has only the `freeform` variant in
`ApplyPatchToolType`. Its patch handler rejects a function payload.

## Terms

- **Standard Responses**: tools are top-level `tools`, while stable base
  instructions are sent in top-level `instructions`.
- **Responses Lite**: tools are placed in an `additional_tools` developer input
  item, instructions become another developer input item, and top-level tools
  and instructions are omitted or empty.
- **Custom/freeform tool**: a Responses `type:"custom"` tool whose model output
  is raw text rather than a JSON argument string.
- **Function tool**: a Responses `type:"function"` tool whose `arguments` field
  contains JSON text.
- **Code Mode**: a model-visible tool-exposure strategy in which code calls
  nested tools through a freeform `exec` runtime. It is independent from the
  Standard/Lite request envelope.

## Evidence boundaries

The following distinctions matter when using these notes:

- `additional_tools` and the Responses Lite headers are internal Codex
  transport behavior. They must not be assumed to work on arbitrary public or
  proxy Responses endpoints.
- The public built-in apply-patch tool is documented by OpenAI, but it is not
  the protocol used by the analyzed Codex CLI checkout.
- Model entries in Codex `models.json` are capability metadata, not a guarantee
  that another provider exposing a model with the same name accepts the same
  protocol.
- Request compatibility requires both outbound serialization and inbound event
  parsing. Rewriting only `tools` is insufficient for custom/freeform tools.
