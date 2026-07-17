# Standard Codex Responses mode

This document describes the non-Lite request envelope built by the analyzed
Codex CLI. It is distinct from the extension's current provider payload.

## Request shape

The Codex request structure contains these main fields:

```json
{
  "model": "gpt-5.4",
  "instructions": "<stable base instructions>",
  "input": ["<conversation and dynamic context items>"],
  "tools": ["<model-visible tool specs>"],
  "tool_choice": "auto",
  "parallel_tool_calls": true,
  "reasoning": {
    "effort": "medium",
    "summary": "auto"
  },
  "store": false,
  "stream": true,
  "include": ["reasoning.encrypted_content"],
  "service_tier": null,
  "prompt_cache_key": "<session-derived key>",
  "text": {
    "verbosity": "medium"
  },
  "client_metadata": {}
}
```

Optional and model-dependent fields are omitted when not applicable. The
actual reasoning effort, summary, verbosity, service tier, and tool list come
from model metadata plus session configuration.

## Prompt and context placement

In Standard mode Codex separates two kinds of context:

- `instructions` receives `prompt.base_instructions.text`.
- `input` receives formatted conversation items and dynamic developer/user
  context already assembled into the prompt history.

This keeps a stable instruction prefix separate from turn and workspace state.
It also means an adapter must not blindly replace the application's project,
permission, AGENTS, skills, or user-defined instructions with Codex defaults.

## Tool placement

All model-visible tool specifications are serialized into the top-level
`tools` array. For freeform apply patch, one entry has this shape:

```json
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
```

`ToolSpec` can also serialize function, namespace, tool-search, and web-search
specifications. The router's model-visible specs and registered executors are
related but not identical: Code Mode may register tools locally while hiding
them from the top-level model tool list.

## Parallel calls

The request value is derived from `prompt.parallel_tool_calls`. Model metadata
also records whether a model supports parallel tool calls. Tool execution has a
second, local policy: each handler declares whether its calls can run in
parallel. Request-level parallelism therefore does not imply that overlapping
filesystem mutations are safe to execute concurrently.

## Reasoning and text controls

Codex builds reasoning controls from model metadata and session options:

- `effort` uses an explicit option or the model default.
- `summary` is included only when the model supports the parameter and the
  configured summary mode is not `none`.
- `reasoning.context` is omitted in Standard mode, leaving the Responses
  default, documented in source comments as `current_turn`.
- `text.verbosity` is included only for models that support verbosity.
- `text.format` may also carry an output JSON schema.

## Storage, caching, and continuation

- Codex sets `store` according to the provider; the analyzed code enables it
  for Azure Responses endpoints and otherwise leaves it false.
- `prompt_cache_key` is included in the logical request.
- WebSocket requests can use `previous_response_id` only when the new logical
  input extends the exact previous input prefix and all context-affecting
  request fields match.
- Matching includes model, instructions, tools, tool choice, parallel flag,
  reasoning, store, include, service tier, prompt cache key, and text controls.
  A mode, model, tool, or prompt change therefore forces a full request.

## Transport

The same logical request is used for HTTP/SSE and Responses WebSocket. The
WebSocket request adds `previous_response_id` and `generate` fields. Stream
events are normalized into Codex `ResponseEvent` values before the session
loop processes text, reasoning, tool deltas, and completed output items.

## Codex sources

- `codex-rs/codex-api/src/common.rs`
- `codex-rs/core/src/client.rs`
- `codex-rs/core/src/client_common.rs`
- `codex-rs/tools/src/tool_spec.rs`
- `codex-rs/core/src/tools/spec_plan.rs`
- `codex-rs/codex-api/src/endpoint/responses_websocket.rs`