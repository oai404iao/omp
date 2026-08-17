# Model capability, Responses mode, and Code Mode

Codex makes tool behavior from several independent pieces of model metadata.
An adapter should not collapse them into one “is GPT-5” flag.

## Independent capability axes

| Axis | Example values | Controls |
| --- | --- | --- |
| Apply-patch tool type | `freeform`, absent | Declaration and call protocol for direct apply patch |
| Responses envelope | Standard, Lite | Placement of instructions/tools and Lite transport signals |
| Tool exposure mode | direct, `code_mode`, `code_mode_only` | Which registered tools are directly visible to the model |
| Parallel support | true, false | Whether the model/request may produce parallel calls |
| Hosted tool support | web/image variants | Whether server-executed Responses tools may be declared |
| Reasoning controls | effort, summary, context | Model reasoning request fields |
| Text controls | verbosity, output schema | Responses `text` request fields |

Provider and endpoint capability form another axis. A proxy can reuse a Codex
model slug without accepting custom grammar, Lite headers, or hosted tools.

## ApplyPatchToolType

At the analyzed commit the Rust enum contains only:

```text
ApplyPatchToolType::Freeform
```

Model metadata serializes this as:

```json
{
  "apply_patch_tool_type": "freeform"
}
```

When selected, the direct apply-patch spec is the custom + Lark grammar tool
described in [apply-patch-protocols.md](apply-patch-protocols.md). There is no
function or public built-in variant in this Codex enum at the analyzed commit.

## Direct tool exposure

Without Code Mode Only, the model-visible tool plan can directly include
`apply_patch`. The model emits a `custom_tool_call`, and the router dispatches
it to `ApplyPatchHandler`.

The handler and local runtime remain responsible for parsing, path resolution,
sandbox checks, approval policy, mutation, event emission, and the final tool
output. Grammar-constrained generation does not grant filesystem authority.

## Code Mode

Code Mode introduces a freeform `exec` tool backed by a JavaScript-oriented
runtime. Code executed there can call nested tools using a `tools` object.

Conceptually:

```js
const result = await tools.apply_patch(
  "*** Begin Patch\n*** Update File: src/a.ts\n@@\n-old\n+new\n*** End Patch\n"
);
```

Nested calls still go through Codex's tool router and handlers. Code Mode is
therefore an alternate model-facing orchestration layer, not a replacement for
the apply-patch parser or security checks.

## Code Mode Only

When `tool_mode:"code_mode_only"` is active, Codex hides most tools that would
otherwise be directly model-visible. It exposes the freeform `exec` tool and a
small allowed set of direct controls such as waiting, while making other
registered tools available as nested tools inside the runtime.

Across the Code Mode test suite, Codex separately verifies that Code Mode Only:

- restricts the prompt-visible tool list;
- can discover/call deferred application tools;
- can call nested core tools;
- can route MCP tools.

Another Code Mode test verifies that `tools.apply_patch(...)` can be called
through `exec` and produces the expected filesystem change. Together with the
Code Mode Only tool-planning tests, this establishes the nested-tool mechanism
without claiming that Responses Lite itself supplies that runtime.

Implementing only Responses Lite does not implement these runtime semantics.
A complete Code Mode port also needs a controlled runtime, nested-tool schema
generation, router integration, result adaptation, cancellation/yield/wait,
permissions, output truncation, and tests for arbitrary code execution.

## Hosted tools and Lite

The tool planner treats hosted tools separately from client tool specs. Source
comments state that Responses Lite accepts client-executed schemas rather than
hosted Responses tools, so the planner omits hosted specs in Lite.

Standalone or namespace implementations of web/image operations are client
tools and can still be represented differently. They must not be confused with
the hosted `type:"web_search"` or `type:"image_generation"` declarations.

## Analyzed model snapshot

The bundled catalog at commit `eb9dceba1a` includes the following relevant
combinations:

| Models | Apply patch | Responses | Tool mode |
| --- | --- | --- | --- |
| `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna` | freeform | Lite | Code Mode Only |
| `gpt-5.5`, `gpt-5.4`, `gpt-5.4-mini`, `gpt-5.2` and other listed Codex models | freeform | Standard | direct/no forced Code Mode Only |

This table describes the bundled snapshot, not every OpenAI deployment. The
catalog also gives each model separate defaults for reasoning effort, summary,
verbosity, context window, modalities, and parallel calls.

This extension exposes the summary axis as
`responses.reasoningSummary:"auto" | "concise" | "detailed" | "none"` in its
per-model catalog. `"none"` omits the wire field; absent values preserve the
extension's mode defaults (Standard `auto`, Lite `none`).

## Capability-resolution consequence

A compatible host needs a resolved profile with separate fields, for example:

```ts
interface ResponsesCapabilityProfile {
  envelope: "standard" | "lite";
  applyPatch: "custom" | "function" | "disabled";
  toolExposure: "direct" | "code-mode-only";
  hostedTools: boolean;
  parallelToolCalls: boolean;
}
```

Resolution should use explicit configuration and provider/model metadata. A
model-name heuristic may be a fallback hint, but it cannot prove that an
endpoint supports an internal transport.

This extension resolves those axes from exact `provider/model` entries. It
does not implement `toolExposure:"code-mode-only"`; Lite models receive direct
custom/namespace tools instead of Codex's JavaScript `exec` runtime.

## Codex sources

- `codex-rs/protocol/src/openai_models.rs`
- `codex-rs/models-manager/src/model_info.rs`
- `codex-rs/models-manager/models.json`
- `codex-rs/core/src/tools/spec_plan.rs`
- `codex-rs/core/src/tools/code_mode/execute_spec.rs`
- `codex-rs/tools/src/code_mode.rs`
- `codex-rs/core/tests/suite/code_mode.rs`
- `codex-rs/core/tests/suite/responses_lite.rs`
