# Codex Responses protocol reference

This directory records the Codex request modes, tool wire contracts, model
capabilities, standalone extensions, and replay behavior used to design this
extension.

## Snapshot and scope

- Codex checkout: `openai/codex`
- Primary analyzed commit:
  `eb9dceba1a2e658142a456c5898836774835616b`
- Local analysis date: August 12, 2026
- Primary implementation: `codex-rs/`

Source paths are relative to that checkout unless noted. Model availability
and internal fields can change after the snapshot.

The local apply-patch executor behavior note retains the earlier
`03bb3b12367397e14a8facc2e018d645ff4d8e83` execution baseline and documents
Pi-specific safety differences. The freeform grammar itself was unchanged in
the current snapshot.

## Reading order

1. [Model catalog and standalone extensions](model-catalog.md) explains the
   extension's exact per-model configuration and provider binding.
2. [Standard Responses mode](responses-standard.md) records the normal request
   envelope and tool placement.
3. [Responses Lite mode](responses-lite.md) records the internal Lite
   transformation, namespace tools, headers, and restrictions.
4. [Apply-patch wire protocols](apply-patch-protocols.md) separates the Codex
   freeform custom tool, public built-in tool, and JSON function fallback.
5. [Streaming, parsing, and replay](streaming-parsing-and-replay.md) follows
   custom and namespaced calls through SSE/WebSocket and the next request.
6. [Apply-patch behavior](apply-patch-behavior.md) records local parsing,
   matching, mutation, and rendering behavior.
7. [Model modes and Code Mode](model-modes-and-code-mode.md) separates request
   envelope, tool exposure, and model capability.
8. [Web search](web-search-streaming-rendering.md) covers hosted lifecycle,
   citations, and standalone `web.run`.
9. [Source map](source-map.md) maps conclusions to Codex source and tests.

Remote compaction v2 appends `compaction_trigger` and uses the ordinary
Responses streaming client. It can therefore reuse the same WebSocket and
`previous_response_id` state as a normal turn. The legacy
`/responses/compact` endpoint remains a separate unary request. Both request
forms retain the Lite envelope when the active model uses Responses Lite.

The packaged freeform grammar is
[`src/providers/codex-apply-patch.lark`](../src/providers/codex-apply-patch.lark).

## Protocol taxonomy

| Name | Declaration | Call item | Result item | Codex CLI |
| --- | --- | --- | --- | --- |
| Codex freeform apply patch | `type:"custom"` | `custom_tool_call` | `custom_tool_call_output` | Yes |
| Public built-in apply patch | `type:"apply_patch"` | `apply_patch_call` | `apply_patch_call_output` | No |
| JSON function fallback | `type:"function"` | `function_call` | `function_call_output` | No |

In current Responses Lite, top-level function and freeform specs are nested
under the `functions` namespace. Standalone web and image tools use `web.run`
and `image_gen.imagegen`.

## Terms

- **Standard Responses**: stable instructions and tools are top-level fields.
- **Responses Lite**: tools are in an `additional_tools` developer item,
  instructions are a developer message, and Lite transport signals are added.
- **Namespace tool**: a named group containing function and/or custom child
  tools. Calls retain separate `namespace` and `name` fields.
- **Custom/freeform tool**: raw text input constrained by an optional grammar.
- **Hosted tool**: server-executed Responses tool such as `web_search`.
- **Standalone tool**: client-executed namespace tool that calls a dedicated
  Codex endpoint.
- **Code Mode**: a separate execution/tool-exposure strategy using a freeform
  `exec` runtime.

## Evidence boundaries

- Responses Lite fields and signals are internal Codex behavior and must be
  enabled only for known-compatible endpoints.
- A model slug does not prove that a proxy implements its Codex protocol.
- Hosted and standalone tools with similar names have different declarations,
  execution paths, and result lifecycles.
- Supporting custom or namespace tools requires outbound serialization,
  inbound parsing, execution mapping, and exact history replay.
- This extension implements direct custom/namespace tools, not Codex Code Mode.
