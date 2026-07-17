# Codex source map

This map points from protocol conclusions to the source files used to verify
them. Paths are relative to the analyzed `openai/codex` checkout at commit
`03bb3b12367397e14a8facc2e018d645ff4d8e83`.

## Apply-patch declaration and grammar

| Source | Evidence |
| --- | --- |
| `codex-rs/core/src/tools/handlers/apply_patch_spec.rs` | Creates `ToolSpec::Freeform`, embeds the grammar, and supplies the exact FREEFORM description. |
| `codex-rs/core/src/tools/handlers/apply_patch.lark` | Canonical patch syntax accepted by the custom tool grammar. |
| `codex-rs/core/src/tools/handlers/apply_patch_spec_tests.rs` | Verifies normal and multi-environment custom specs. |
| `codex-rs/tools/src/responses_api.rs` | Defines `FreeformTool` and its grammar format. |
| `codex-rs/tools/src/tool_spec.rs` | Serializes `ToolSpec::Freeform` as Responses `type:"custom"`. |
| `codex-rs/protocol/src/openai_models.rs` | Defines `ApplyPatchToolType`; only `Freeform` exists at this snapshot. |

## Response item and router types

| Source | Evidence |
| --- | --- |
| `codex-rs/protocol/src/models.rs` | Defines `AdditionalTools`, `CustomToolCall`, `CustomToolCallOutput`, and function/custom response input items. |
| `codex-rs/core/src/tools/router.rs` | Maps `CustomToolCall.input` to `ToolPayload::Custom`; function calls remain distinct. |
| `codex-rs/core/src/tools/context.rs` | Selects `custom_tool_call_output` when the original payload is custom. |
| `codex-rs/core/src/tools/handlers/apply_patch.rs` | Rejects non-custom payloads, parses/verifies input, and dispatches execution. |
| `codex-rs/core/src/tools/runtimes/apply_patch.rs` | Runs verified patch actions under Codex runtime policy. |
| `codex-rs/apply-patch/src/lib.rs` | Patch verification, action construction, and error behavior. |

## Streaming parser

| Source | Evidence |
| --- | --- |
| `codex-rs/codex-api/src/sse/responses.rs` | Parses `response.custom_tool_call_input.delta` into `ToolCallInputDelta`. |
| `codex-rs/core/src/session/turn.rs` | Creates argument-diff consumers on custom item add, consumes deltas, and finalizes on item done. |
| `codex-rs/apply-patch/src/streaming_parser.rs` | Incrementally parses raw patch lines and hunks. |
| `codex-rs/core/src/tools/handlers/apply_patch.rs` | Converts streamed hunks into throttled patch update events. |

## Request construction

| Source | Evidence |
| --- | --- |
| `codex-rs/codex-api/src/common.rs` | Defines Standard and WebSocket request fields including instructions, tools, reasoning, cache key, text, and metadata. |
| `codex-rs/core/src/client.rs` | Builds Standard/Lite requests, reasoning controls, headers, WebSocket metadata, and continuation state. |
| `codex-rs/core/src/client_common.rs` | Formats request input and strips image details in Lite. |
| `codex-rs/codex-api/src/endpoint/responses_websocket.rs` | Serializes Responses WebSocket requests and previous-response continuation. |
| `codex-rs/core/tests/suite/client.rs` | Request snapshots and client behavior. |
| `codex-rs/core/tests/suite/agent_websocket.rs` | WebSocket request, reconnect, and model-change behavior. |

## Responses Lite

| Source | Evidence |
| --- | --- |
| `codex-rs/core/src/client.rs` | Moves tools into `AdditionalTools`, moves base instructions into a developer input item, disables parallel calls, and adds Lite transport metadata. |
| `codex-rs/protocol/src/models.rs` | Defines the internal `AdditionalTools` response item. |
| `codex-rs/core/src/tools/spec_plan.rs` | Omits hosted Responses tools in Lite. |
| `codex-rs/core/tests/suite/responses_lite.rs` | Verifies request shape, headers, tool placement, reasoning context, image detail removal, and hosted-tool exclusion. |
| `codex-rs/models-manager/models.json` | Marks model entries with `use_responses_lite` and other capabilities. |

## Code Mode and tool exposure

| Source | Evidence |
| --- | --- |
| `codex-rs/core/src/tools/spec_plan.rs` | Plans direct, hidden, hosted, and Code Mode tool exposure. |
| `codex-rs/core/src/tools/code_mode/execute_spec.rs` | Defines the model-visible freeform `exec` spec. |
| `codex-rs/tools/src/code_mode.rs` | Defines Code Mode tool/runtime structures. |
| `codex-rs/core/tests/suite/code_mode.rs` | Verifies nested tools, Code Mode Only restrictions, MCP/app tools, and apply patch through `exec`. |
| `codex-rs/models-manager/models.json` | Marks models with `tool_mode:"code_mode_only"`. |

## Prompt and model metadata

| Source | Evidence |
| --- | --- |
| `codex-rs/core/src/session/mod.rs` | Aggregates base/developer/session context. |
| `codex-rs/models-manager/models.json` | Bundled instructions and defaults for reasoning, summary, verbosity, modalities, Lite, and tool modes. |
| `codex-rs/models-manager/src/model_info.rs` | Model metadata representation and defaults. |
| `codex-rs/prompts/templates/apply_patch_tool_instructions.md` | Model-facing apply-patch usage guidance. |

## External protocol references

- OpenAI apply-patch built-in guide:
  <https://developers.openai.com/api/docs/guides/tools-apply-patch>
- OpenAI custom/function tools guide referenced by Codex source:
  <https://platform.openai.com/docs/guides/function-calling#custom-tools>
- GPT-5.1 prompting guide:
  <https://github.com/openai/openai-cookbook/blob/main/examples/gpt-5/gpt-5-1_prompting_guide.ipynb>
- Codex prompting guide:
  <https://github.com/openai/openai-cookbook/blob/main/examples/gpt-5/codex_prompting_guide.ipynb>

The public built-in guide is included for protocol comparison. It is not
evidence that the analyzed Codex CLI uses `tools:[{"type":"apply_patch"}]`.