# Codex Responses Lite mode

Responses Lite is a different request envelope selected by Codex model
metadata. It is not merely Standard Responses with fewer optional fields.

The analyzed implementation treats Lite as internal Codex transport behavior.
It uses an internal request header and a special `additional_tools` input item,
so it must not be enabled for arbitrary public or proxy Responses endpoints
based only on a model-name match.

## Request transformation

Codex first formats the normal conversation input and serializes all client
tool specifications. When `model_info.use_responses_lite` is true it then:

1. Inserts an `additional_tools` item at the beginning of `input`.
2. Places serialized client tool definitions in that item's `tools` field.
   Top-level function and freeform specs are coalesced into the default
   `functions` namespace; explicit non-default namespaces remain separate.
3. Inserts base instructions as the next `developer` message when non-empty.
4. Sets internal `instructions` to an empty string, which is omitted on the
   wire because the field uses `skip_serializing_if = "String::is_empty"`.
5. Sets top-level `tools` to `None`, which omits the field.
6. Forces `parallel_tool_calls` to `false`.
7. Sets `reasoning.context` to `all_turns`.
8. Removes `detail` from input images, including images in structured tool
   outputs.

Representative wire shape:

```json
{
  "model": "gpt-5.6-terra",
  "input": [
    {
      "type": "additional_tools",
      "role": "developer",
      "tools": [
        {
          "type": "namespace",
          "name": "functions",
          "description": "",
          "tools": [
            {
              "type": "custom",
              "name": "apply_patch",
              "description": "Use the `apply_patch` tool to edit files. This is a FREEFORM tool, so do not wrap the patch in JSON.",
              "format": {
                "type": "grammar",
                "syntax": "lark",
                "definition": "<grammar>"
              }
            }
          ]
        },
        {
          "type": "namespace",
          "name": "web",
          "description": "Tools in the web namespace.",
          "tools": [
            {
              "type": "function",
              "name": "run",
              "description": "<standalone web-search description>",
              "strict": false,
              "parameters": "<SearchCommands schema>"
            }
          ]
        }
      ]
    },
    {
      "type": "message",
      "role": "developer",
      "content": [
        {
          "type": "input_text",
          "text": "<base instructions>"
        }
      ]
    },
    "<conversation items>"
  ],
  "tool_choice": "auto",
  "parallel_tool_calls": false,
  "reasoning": {
    "effort": "medium",
    "context": "all_turns"
  },
  "store": false,
  "stream": true,
  "include": ["reasoning.encrypted_content"],
  "prompt_cache_key": "<session-derived key>",
  "text": {
    "verbosity": "low"
  },
  "client_metadata": {}
}
```

`additional_tools` is represented by an internal `ResponseItem` variant with
an optional `id`, a `role`, and a JSON tool array. It is intentionally skipped
from generated public schema/type bindings in Codex source.

The `functions` namespace is omitted when it has no children. Its default
description is the empty string. Existing `functions` namespaces are merged,
and custom/freeform children are valid alongside function children.

## HTTP/SSE and WebSocket signals

For HTTP/SSE Codex adds:

```http
x-openai-internal-codex-responses-lite: true
```

For Responses WebSocket it adds this client-metadata entry:

```json
{
  "ws_request_header_x_openai_internal_codex_responses_lite": "true"
}
```

The WebSocket metadata key tells the service to attach the corresponding
request header; it is not the same as adding a normal application tool or
message.

## Hosted-tool restriction

Codex source states that Responses Lite accepts schemas for client-executed
tools, not hosted Responses tools. The Lite tool plan therefore skips hosted
tool specs. Tests assert that hosted `web_search` and `image_generation` are
absent in the normal Lite plan.

Where Codex has a standalone/client-executed extension, a similarly named
capability may still be exposed as a function or namespace tool. That does not
make the hosted Responses schema valid in Lite.

Current standalone identities are:

```text
web.run
image_gen.imagegen
```

Consequences for an adapter:

- A tool rewrite must inspect `input[].type == "additional_tools"`; changing
  only top-level `tools` does nothing in Lite.
- Hosted-tool placeholder rewriting must be disabled or replaced with an
  actual client-executed implementation.
- The system/developer prompt must be moved without dropping project context.
- Prompt caching and WebSocket continuation comparisons must include the
  transformed request profile.
- Inbound function/custom calls must preserve `namespace` for execution and
  later history replay.

## Compaction

Responses Lite is retained for both Codex compaction request forms:

- remote compaction v2 appends `compaction_trigger` to the Lite input and uses
  the normal SSE or WebSocket transport;
- legacy `/responses/compact` receives the Lite header and the same
  `additional_tools`, developer-message, parallel, and reasoning fields.

Compaction is therefore a provider/model capability, not a Standard-only
feature.

## Models in the analyzed snapshot

The bundled Codex model catalog marks these visible entries with all three of
the following: freeform apply patch, `tool_mode:"code_mode_only"`, and
`use_responses_lite:true`:

- `gpt-5.6-sol`
- `gpt-5.6-terra`
- `gpt-5.6-luna`

This is a snapshot, not a permanent allowlist. Another provider can expose the
same slug without implementing the internal Lite contract.

## Lite is not Code Mode

Responses Lite controls request serialization. Code Mode controls which tools
the model sees and how it invokes nested client tools. The three models above
happen to enable both in this Codex snapshot, but an implementation must keep
the two capabilities separate.

It is possible to construct a Lite request containing a direct custom
`apply_patch` tool. That is wire-compatible with Lite's `additional_tools`
container, but it does not reproduce Codex's `code_mode_only` exposure or
behavior.

## Standard versus Lite

| Concern | Standard Responses | Responses Lite |
| --- | --- | --- |
| Base instructions | Top-level `instructions` | Developer message in `input` |
| Tool definitions | Top-level `tools` | First `additional_tools` input item |
| Top-level tools | Present | Omitted |
| Parallel tool calls | Prompt-controlled | Forced `false` |
| Reasoning context | Omitted/default `current_turn` | `all_turns` |
| Image `detail` | Preserved | Removed |
| Hosted Responses tools | May be present | Skipped |
| Transport signal | Normal Responses headers | Internal Lite header/WS metadata |

## Codex sources

- `codex-rs/core/src/client.rs`
- `codex-rs/core/src/client_common.rs`
- `codex-rs/codex-api/src/common.rs`
- `codex-rs/protocol/src/models.rs`
- `codex-rs/tools/src/tool_spec.rs`
- `codex-rs/tools/src/responses_api.rs`
- `codex-rs/core/src/tools/spec_plan.rs`
- `codex-rs/ext/web-search/src/tool.rs`
- `codex-rs/ext/image-generation/src/tool.rs`
- `codex-rs/core/tests/suite/responses_lite.rs`
- `codex-rs/core/tests/suite/agent_websocket.rs`
- `codex-rs/models-manager/models.json`
