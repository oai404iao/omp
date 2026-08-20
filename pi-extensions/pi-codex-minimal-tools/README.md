# @oai404iao/pi-codex-minimal-tools

Codex-specific Responses support for Pi, driven by an exact per-model JSON
catalog instead of model-name heuristics.

Compatibility: Pi 0.84.2 or newer; tested against 0.84.2.

> npm identity: `@oai404iao/pi-codex-minimal-tools`. This package remains
> private while its third-party source review is incomplete, so install it
> from a local checkout.

The extension adds:

- Responses SSE, WebSocket, cached continuation, WebSocket retry, upgrade-only
  SSE fallback, and WebSocket prewarm.
- Standard Responses and the internal Codex Responses Lite envelope.
- Codex freeform `apply_patch`, including streaming preview and exact replay.
- Hosted Responses web search or standalone Codex `web.run`.
- Hosted Responses image generation or standalone Codex `image_gen.imagegen`.
- Codex remote compaction v2 and legacy `/responses/compact`.
- Per-model Fast service tiers.
- User overrides and user-added provider/model profiles.

Unknown models are not guessed. They keep Pi's native provider implementation
and do not receive package tools.

## Install

```bash
pi install /absolute/path/to/pi-codex-minimal-tools
```

Restart Pi or run `/reload`.

## Commands

| Command | Action |
| --- | --- |
| `/codex-minimal-tools` | Show the active model profile and effective capabilities. |
| `/codex-minimal-tools:doctor` | Show config/catalog diagnostics. |
| `/fast [on\|off\|status]` | Toggle the active profile's Fast service tier. |
| `/image-gen <prompt> [@reference.png]` | Run background image generation or editing. |

## Two Configuration Files

There are two separate model-related files:

1. Pi's agent `models.json` defines providers and actual models: API type,
   base URL, authentication, headers, modalities, context window, and cost.
2. This extension's `models.json` defines Codex behavior for an exact
   `provider/model` ID: Responses mode, reasoning summary, transport, tools,
   compaction, and Fast.

Typical paths:

```text
<PI_CODING_AGENT_DIR>/models.json
<PI_CODING_AGENT_DIR>/extensions/pi-codex-minimal-tools/models.json
<PI_CODING_AGENT_DIR>/extensions/pi-codex-minimal-tools/config.json
```

Without `PI_CODING_AGENT_DIR`, Pi normally uses `~/.config/pi/agent` or
`~/.pi/agent`, depending on the installation.

### Extension Global Config

`config.json` now contains only package-wide preferences:

```json
{
  "$schema": "https://unpkg.com/@oai404iao/pi-codex-minimal-tools@1/config.schema.json",
  "enabled": true,
  "glyphStyle": "unicode",
  "autoEnable": true,
  "fastMode": false,
  "imageOutputDir": ".pi/openai-codex-images",
  "imageModel": "gpt-image-2",
  "directImageApiFallback": false,
  "viewImageWorkspaceOnly": false,
  "deferApplyPatchRendering": false
}
```

| Setting | Meaning |
| --- | --- |
| `enabled` | Enable all package behavior. |
| `glyphStyle` | Use `unicode` or `ascii` UI glyphs. |
| `autoEnable` | Add supported package tools automatically. |
| `fastMode` | Global user toggle; only profiles with `fast` are affected. |
| `imageOutputDir` | Generated-image output directory. Relative paths resolve from the workspace root. |
| `imageModel` | Image model used by standalone/hosted image requests and direct fallback. |
| `directImageApiFallback` | Permit the separate `OPENAI_API_KEY` Images API fallback. |
| `viewImageWorkspaceOnly` | Restrict `view_image` to the workspace. |
| `deferApplyPatchRendering` | Use Pi's fallback renderer instead of the streaming patch preview. |

The older model-level keys remain readable for one migration version, but are
deprecated. See [Legacy migration](#legacy-migration).

### Per-Model Catalog

Create:

```text
<PI_CODING_AGENT_DIR>/extensions/pi-codex-minimal-tools/models.json
```

Example overriding a bundled model and adding a custom provider/model:

```json
{
  "$schema": "https://unpkg.com/@oai404iao/pi-codex-minimal-tools@1/models.schema.json",
  "version": 1,
  "models": [
    {
      "id": "openai/gpt-5.5",
      "responses": {
        "reasoningSummary": "none",
        "transport": "sse",
        "websocketPrewarm": false
      },
      "tools": {
        "webSearch": false
      }
    },
    {
      "id": "my-provider/my-codex-model",
      "extends": "openai/gpt-5.5",
      "responses": {
        "endpoint": "openai",
        "transport": "websocket-cached"
      },
      "tools": {
        "imageGeneration": false
      }
    }
  ]
}
```

Resolution rules:

- IDs are exact, case-insensitive `provider/model` matches.
- A user entry with the same ID deep-overrides the bundled entry.
- `extends` can inherit from a bundled or user profile.
- Objects merge recursively; arrays replace the inherited array.
- Duplicate IDs, malformed JSON, missing parents, cycles, and unknown fields
  are reported by `/codex-minimal-tools:doctor`.
- Each effective profile has a stable hash. WebSocket continuation, sticky
  fallback, and native-compaction replay are isolated by that hash.

Full field documentation is in
[`reference/model-catalog.md`](https://github.com/oai404iao/omp/blob/main/pi-extensions/pi-codex-minimal-tools/reference/model-catalog.md), and editor
validation is provided by [`models.schema.json`](models.schema.json).

## Custom Provider Example

The custom model must exist in Pi's agent `models.json`. For provider-shim
features, its Pi `api` must be `openai-responses` or
`openai-codex-responses`:

```json
{
  "providers": {
    "my-provider": {
      "baseUrl": "https://api.example.com/v1",
      "apiKey": "$MY_PROVIDER_API_KEY",
      "api": "openai-responses",
      "models": [
        {
          "id": "my-codex-model",
          "name": "My Codex Model",
          "reasoning": true,
          "input": ["text", "image"],
          "contextWindow": 272000,
          "maxTokens": 16384,
          "cost": {
            "input": 0,
            "output": 0,
            "cacheRead": 0,
            "cacheWrite": 0
          }
        }
      ]
    }
  }
}
```

The extension dynamically attaches only its stream handler to a selected
custom provider. It does not replace the provider's URL, authentication,
headers, or model definitions.

If a profile requests the provider shim but the Pi model uses another API
type, wire-only features are disabled:

- hosted web/image tools;
- custom/freeform `apply_patch`;
- native Responses compaction;
- Fast service tiers.

Standalone web/image tools and function `apply_patch` can still be used when
the profile enables them.

## Model Profile Fields

```json
{
  "id": "provider/model",
  "extends": "provider/parent-model",
  "enabled": true,
  "responses": {
    "providerShim": true,
    "endpoint": "auto",
    "mode": "standard",
    "reasoningSummary": "auto",
    "systemPromptPlacement": "instructions",
    "transport": "auto",
    "websocketPrewarm": true
  },
  "tools": {
    "parallelCalls": true,
    "applyPatch": "custom",
    "webSearch": {
      "implementation": "hosted",
      "contentTypes": ["text", "image"]
    },
    "imageGeneration": "standalone",
    "viewImage": false
  },
  "compaction": "responses",
  "fast": {
    "serviceTier": "priority",
    "costMultiplier": 2
  }
}
```

Important constraints:

- `responses.reasoningSummary` accepts `"auto"`, `"concise"`, `"detailed"`,
  or `"none"`. `"none"` omits `reasoning.summary`; when absent, Standard
  defaults to `"auto"` and Lite defaults to `"none"`.
- `responses.mode:"lite"` always uses a developer message, namespace tools in
  `additional_tools`, `parallel_tool_calls:false`,
  `reasoning.context:"all_turns"`, and strips input-image `detail`.
- Lite cannot use hosted `web_search` or hosted `image_generation`; choose
  `standalone` instead.
- `tools.applyPatch:"custom"` uses the Codex freeform grammar and requires the
  provider shim. `"function"` works as a normal Pi tool.
- `responses.endpoint:"openai"` uses API-key endpoint/auth semantics.
  `"codex"` uses ChatGPT/Codex endpoint/auth semantics. `"auto"` infers from
  the provider.
- `compaction:"responses"` uses `compaction_trigger` through the selected
  SSE/WebSocket transport. `"responses-compact"` uses the legacy unary
  endpoint. `"pi"` keeps Pi summaries.

## Built-In Profiles

The bundled catalog is based on local Codex commit
`eb9dceba1a2e658142a456c5898836774835616b` from August 12, 2026.

| Models | Responses | Web | Image | Patch | Compaction |
| --- | --- | --- | --- | --- | --- |
| `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna` | Lite, auto WS/SSE | standalone text+image | standalone | custom | responses |
| `gpt-5.5`, `gpt-5.4` | Standard, auto WS/SSE | hosted text+image | standalone | custom | responses |
| `gpt-5.4-mini`, `codex-auto-review` | Standard, auto WS/SSE | hosted text+image | standalone | custom | responses |
| `gpt-5.2` | Standard, auto WS/SSE | hosted text | standalone | custom | responses |
| legacy GPT-5/Codex entries | inherited Standard profile | profile-specific | standalone | custom | responses |
| `gpt-4.1` | Standard SSE | off | hosted | off | Pi |
| `o4-mini` | Standard SSE | off | off | off | Pi |

Equivalent `openai/...` and `openai-codex/...` IDs are included; the latter
switch only the endpoint/auth shape to `codex`.

These entries are defaults, not claims that every proxy with the same model
slug supports the protocol. Override or disable a profile for the endpoint
actually in use.

## Web Search

`tools.webSearch` supports two implementations:

- `hosted`: rewrites the Pi placeholder to Responses
  `{"type":"web_search"}` and preserves progress, sources, results, and
  citation replay. Standard Responses only.
- `standalone`: exposes `web.run` as a client-executed namespace tool and calls
  the provider's `alpha/search` endpoint. It supports search/image queries,
  open/click/find, PDF screenshots, finance, weather, sports, and time.

Standalone search sends a bounded recent visible conversation tail, resolved
Pi authentication, direct-caller/live-web settings, the active turn metadata,
and the model's 10,000-token truncation budget. Search rows stay compact by
default and show deduplicated source hosts; expand the tool row to inspect the
raw result text.

## Image Generation

`tools.imageGeneration` supports:

- `hosted`: Responses `image_generation`.
- `standalone`: `image_gen.imagegen`, backed by the provider's
  `images/generations` and `images/edits` endpoints.

Standalone input follows current Codex:

- required `prompt`;
- up to five `referenced_image_paths`; or
- `num_last_images_to_include` from 1 through 5.

Generated PNGs are saved under `imageOutputDir`, mirrored to `latest.png`, and
returned to the model before the saved-path text. `/image-gen` selects any
loaded image-capable model with an enabled catalog profile.

## WebSocket And Compaction

`transport` values:

- `sse`: HTTP streaming only.
- `websocket`: reusable WebSocket; exact logical prefixes opportunistically use
  `previous_response_id` input deltas.
- `websocket-cached`: compatibility alias with the same safe continuation
  behavior.
- `auto`: retry transient WebSocket failures, but use sticky per-session SSE
  fallback only when the WebSocket upgrade is rejected with HTTP 426. Model,
  request, output-limit, context-limit, and post-upgrade connection errors do
  not change transports.

Prewarm is scheduled once per session startup (including resume/fork), in the
background without delaying session initialization. If the first WebSocket
request starts while prewarm is pending, it consumes that one startup handle
before sending. Prewarm sends a best-effort `response.create` with
`generate:false` containing only the startup system/tool/request
envelope—never conversation history or the pending user message. The first real
request appends its full conversation input, and later turns continue from real
response IDs. A failed or timed-out prewarm is not retried on every user
message. Continuation reuse always requires the new request to extend the
previous logical request exactly.

Native compaction stores opaque encrypted state in the Pi session. New
checkpoints replay only to the same provider, model, API, and effective
profile hash. Switching any of those falls back to Pi's retained local
context. Treat session files containing native compaction as sensitive data.

## Apply Patch

When `apply_patch` activates, the extension temporarily hides Pi's `edit` and
`write` tools and restores their prior positions after switching away.

The executor supports Codex `@@ class/function` contexts, ordered update
chunks, `*** Move to:`, `*** End of File`, fuzzy matching, CRLF preservation,
and atomic verification before writes. See
[`reference/apply-patch-behavior.md`](https://github.com/oai404iao/omp/blob/main/pi-extensions/pi-codex-minimal-tools/reference/apply-patch-behavior.md).

## Legacy Migration

These `config.json` keys are deprecated but still projected into an in-memory
model override for compatibility:

| Old key | New model-profile field |
| --- | --- |
| `nativeProviderTools` | `responses.providerShim` plus hosted/standalone tool selection |
| `openaiTransport` | `responses.transport` |
| `openaiWebSocketPrewarm` | `responses.websocketPrewarm` |
| `compactionMode` | `compaction` |
| `requestProfile.responsesMode` | `responses.mode` |
| `requestProfile.reasoningSummary` | `responses.reasoningSummary` |
| `requestProfile.systemPromptPlacement` | `responses.systemPromptPlacement` |
| `requestProfile.patchTransport` | `tools.applyPatch` |
| `apiKeyMode` | `responses.endpoint` |
| `imageGeneration` | `tools.imageGeneration` |
| `webSearchEnabled` | `tools.webSearch` |
| `viewImage` | `tools.viewImage` |
| `applyPatchEnabled` | `tools.applyPatch` |
| `additionalModelIds` | one exact user catalog entry per model |

Move these values to extension `models.json`; legacy projection is intended
only as a transition path.

## Protocol Reference

[`reference/`](https://github.com/oai404iao/omp/tree/main/pi-extensions/pi-codex-minimal-tools/reference) documents the Codex snapshot, Responses
Standard/Lite envelopes, namespace tools, WebSocket continuation, custom-tool
streaming/replay, standalone web/image endpoints, compaction, and apply-patch
protocol.

## License and publication status

Project-authored portions are MIT-licensed, copyright 2026 oai404iao.
Third-party material retains its own terms; see
[LICENSE](LICENSE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

This package is currently private and must not be published until the
provenance review for captured Codex tool metadata is complete.
