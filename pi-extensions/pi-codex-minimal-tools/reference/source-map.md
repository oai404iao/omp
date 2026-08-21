# Codex source map

This map points from protocol conclusions to the source files used to verify
them. Paths are relative to the analyzed `openai/codex` checkout at commit
`eb9dceba1a2e658142a456c5898836774835616b` dated August 12, 2026.

The local executor behavior in [apply-patch behavior](apply-patch-behavior.md)
retains an explicitly documented earlier execution baseline.

## Apply-patch declaration and grammar

| Source | Evidence |
| --- | --- |
| `codex-rs/core/src/tools/handlers/apply_patch_spec.rs` | Creates `ToolSpec::Freeform`, embeds the grammar, and supplies the exact FREEFORM description. |
| `codex-rs/core/src/tools/handlers/apply_patch.lark` | Canonical patch syntax accepted by the custom tool grammar. |
| `codex-rs/core/src/tools/handlers/apply_patch_spec_tests.rs` | Verifies normal and multi-environment custom specs. |
| `codex-rs/tools/src/responses_api.rs` | Defines `FreeformTool` and its grammar format. |
| `codex-rs/tools/src/tool_spec.rs` | Serializes `ToolSpec::Freeform` as Responses `type:"custom"` and coalesces Lite function/custom tools into the `functions` namespace. |
| `codex-rs/protocol/src/openai_models.rs` | Defines `ApplyPatchToolType`; only `Freeform` exists at this snapshot. |

## Response item and router types

| Source | Evidence |
| --- | --- |
| `codex-rs/protocol/src/models.rs` | Defines `AdditionalTools`, `CustomToolCall`, `CustomToolCallOutput`, and function/custom response input items. |
| `codex-rs/tools/src/responses_api.rs` | Defines namespace containers and function/custom namespace children. |
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

## Hosted web-search lifecycle

| Source | Evidence |
| --- | --- |
| `codex-rs/codex-api/src/sse/responses.rs` | Maps `response.output_item.added` and `.done` into normalized response-item events. |
| `codex-rs/protocol/src/models.rs` | Defines `web_search_call` and the search/open-page/find-in-page action union. |
| `codex-rs/core/src/event_mapping.rs` | Converts partial and completed response items into `WebSearchItem` values. |
| `codex-rs/core/src/web_search.rs` | Defines action-detail formatting and query precedence. |
| `codex-rs/core/src/session/turn.rs` | Emits item-started/item-completed lifecycle events from the normalized stream. |
| `codex-rs/core/tests/common/responses.rs` | Provides canonical partial-added and completed web-search SSE fixtures. |
| `codex-rs/core/tests/suite/items.rs` | Verifies matching started/completed web-search items and IDs. |
| `codex-rs/tui/src/chatwidget/tool_lifecycle.rs` | Reconciles the active search cell by call ID and falls back when no start cell exists. |
| `codex-rs/tui/src/history_cell/search.rs` | Renders `Searching the web` and `Searched the web for ...`. |
| `openai/resources/responses/responses.d.ts` | Defines `response.web_search_call.in_progress`, `.searching`, and `.completed`, each keyed by `item_id` and `output_index`. |

## Request construction

| Source | Evidence |
| --- | --- |
| `codex-rs/codex-api/src/common.rs` | Defines Standard and WebSocket request fields including instructions, tools, reasoning, cache key, text, and metadata. |
| `codex-rs/core/src/client.rs` | Builds Standard/Lite requests, reasoning controls, headers, WebSocket metadata, and continuation state. |
| `codex-rs/core/src/client_common.rs` | Formats request input and strips image details in Lite. |
| `codex-rs/codex-api/src/endpoint/responses_websocket.rs` | Serializes Responses WebSocket requests and previous-response continuation. |
| `codex-rs/websocket-client/src/dialer.rs` | Connects directly or through configured proxies and performs target TLS/WebSocket upgrades. |
| `codex-rs/core/tests/suite/client.rs` | Request snapshots and HTTP client behavior. |
| `codex-rs/core/tests/suite/client_websockets.rs` | WebSocket handshake headers, request frames, connection reuse, incremental continuation, and reconnect behavior. |

## Remote compaction transport

| Source | Evidence |
| --- | --- |
| `codex-rs/core/src/compact_remote_v2_attempt.rs` | Appends `ResponseItem::CompactionTrigger` to the current Responses prompt. |
| `codex-rs/core/src/compact_remote_v2.rs` | Runs remote compaction v2 through `ModelClientSession::stream`, collects exactly one compaction output, and installs the new checkpoint history. |
| `codex-rs/core/src/client.rs` | Routes `ModelClientSession::stream` through Responses WebSocket when enabled and computes `previous_response_id` input deltas from the same session continuation state. |
| `codex-rs/core/src/responses_retry.rs` | Applies the compact stream retry budget and session-level HTTP fallback. |
| `codex-rs/core/src/compact_remote_request.rs` | Keeps legacy `/responses/compact` as a separate unary HTTP request. |
| `codex-rs/core/src/client.rs` | Builds the active Standard/Lite envelope before both normal streaming and remote compaction dispatch. |

## Responses Lite

| Source | Evidence |
| --- | --- |
| `codex-rs/core/src/client.rs` | Moves tools into `AdditionalTools`, moves base instructions into a developer input item, disables parallel calls, and adds Lite transport metadata. |
| `codex-rs/protocol/src/models.rs` | Defines the internal `AdditionalTools` response item. |
| `codex-rs/tools/src/tool_spec.rs` | Groups top-level function/freeform tools into `functions`, preserves explicit namespaces, and omits an empty default namespace. |
| `codex-rs/tools/src/responses_api.rs` | Allows function and custom child tools inside a namespace and defines the empty default `functions` description. |
| `codex-rs/core/src/tools/spec_plan.rs` | Omits hosted Responses tools in Lite. |
| `codex-rs/core/tests/suite/responses_lite.rs` | Verifies request shape, headers, tool placement, reasoning context, image detail removal, and hosted-tool exclusion. |
| `codex-rs/models-manager/models.json` | Marks model entries with `use_responses_lite` and other capabilities. |

## Standalone namespace compatibility serialization

`src/codex-reserved-tools.ts` is a modified TypeScript compatibility
serialization of the pinned Codex namespace-tool construction. It preserves
the local `web.run` and `image_gen.imagegen` declaration shapes used in the
internal Responses Lite path; it is neither an exact source-file copy nor a
claim of a stable, OpenAI-supported public API.

| Local surface | Source evidence |
| --- | --- |
| `web.run` namespace/name/function construction | `codex-rs/ext/web-search/src/tool.rs` and `codex-rs/tools/src/responses_api.rs` |
| `web.run` description | `codex-rs/ext/web-search/web_run_description.md`; its local description is byte-for-byte identical |
| `web.run` parameters | `codex-rs/ext/web-search/src/schema.rs` and `codex-rs/codex-api/src/search.rs` |
| `image_gen.imagegen` namespace/name/function construction | `codex-rs/ext/image-generation/src/lib.rs`, `codex-rs/ext/image-generation/src/tool.rs`, and `codex-rs/tools/src/responses_api.rs` |
| `image_gen.imagegen` description | `codex-rs/ext/image-generation/imagegen_description.md`; its local description is byte-for-byte identical |
| `image_gen.imagegen` parameters | `ImagegenArgs` and the schema construction in `codex-rs/ext/image-generation/src/tool.rs` |
| Responses Lite placement | `codex-rs/tools/src/tool_spec.rs` and `codex-rs/core/src/client.rs` |

The package-published
`provenance/openai-codex-eb9dceba-reserved-tools.json` records each immutable
upstream blob ID, SHA-256, raw source URL, and local canonical-JSON
fingerprint. The pinned Cargo manifest and lockfile are included because the
upstream parameter declarations are generated from Rust types.

## Standalone web search

| Source | Evidence |
| --- | --- |
| `codex-rs/ext/web-search/src/tool.rs` | Exposes `web.run`, parses `SearchCommands`, builds recent input, calls the search client, and returns plaintext function output. |
| `codex-rs/ext/web-search/src/history.rs` | Builds the bounded recent visible conversation tail. |
| `codex-rs/ext/web-search/src/extension.rs` | Configures direct caller and external-web settings and gates provider availability. |
| `codex-rs/codex-api/src/search.rs` | Defines the request, command union, settings, response length, and opaque structured results. |
| `codex-rs/codex-api/src/endpoint/search.rs` | Targets `alpha/search`. |
| `codex-rs/core/src/tools/spec_plan.rs` | Selects standalone `web.run` versus hosted `web_search` and forces client tools in Lite. |

## Standalone image generation

| Source | Evidence |
| --- | --- |
| `codex-rs/ext/image-generation/src/tool.rs` | Exposes `image_gen.imagegen`, defines prompt/path/recent-image input, selects generate/edit, and uses current image defaults. |
| `codex-rs/ext/image-generation/src/backend.rs` | Calls the Images client and adds `x-codex-image-turn-id`. |
| `codex-rs/codex-api/src/endpoint/images.rs` | Targets `images/generations` and `images/edits`. |
| `codex-rs/core/src/tools/spec_plan.rs` | Applies feature, provider, auth/plan, namespace, and image-modality gates. |
| `codex-rs/app-server/tests/suite/v2/imagegen_extension.rs` | Verifies generation/edit endpoints, reference/recent images, and turn headers. |

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
