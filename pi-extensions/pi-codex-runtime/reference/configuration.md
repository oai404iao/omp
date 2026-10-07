# Codex extensions — configuration and capability guide

Codex-specific Responses support for Pi, driven by an exact per-model JSON
catalog instead of model-name heuristics.

Peer floor and development target: Pi 0.99.1.

> `@oai404iao/pi-codex-minimal-tools` is a composition-only package.
> Runtime owns shared configuration and schemas; core, web-search and imagegen
> own their implementations and tests. Previously published tarballs are unchanged.
> See [package composition](../../../docs/codex-packages.md) for installation,
> version/lifecycle restrictions and release boundaries.

> **Compatibility boundary:** Responses Lite uses an internal Codex request
> shape. This package pins and tests a compatibility serialization for exact
> configured model profiles, but it is not an OpenAI-supported public API
> contract and may stop working if that internal protocol changes.

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

## Codex Identity

Runtime owns Codex wire identity independently from Pi's session-file id:

- a root has `SessionId === ThreadId`;
- subagents share the root `SessionId` and receive their own `ThreadId`;
- `prompt_cache_key` is the shared `SessionId`;
- `x-client-request-id` is the current `ThreadId`;
- TurnId and `x-codex-turn-state` are scoped to one logical agent turn;
- WindowId is thread-scoped and advances after successful compaction;
- the installation UUIDv4 is stored at
  `<PI_CODING_AGENT_DIR>/pi-codex-minimal-tools/installation_id`.

SSE, Responses Lite, WebSocket, native compaction, and standalone `web.run`
are projections of the same request identity snapshot.

The composition package also exports
`@oai404iao/pi-codex-minimal-tools/subagent-inline`. Its named inline
extension installs only identity lifecycle hooks for SDK-created child
sessions; it does not register providers, tools, commands, or renderers.

## Install

To test this checkout, run root `npm ci --ignore-scripts` and install the bundle
directory. An isolated source directory cannot supply its workspace dependencies:

```bash
pi install /absolute/path/to/omp/pi-extensions/pi-codex-minimal-tools
```

Restart Pi or run `/reload`.

## Commands

| Command | Action |
| --- | --- |
| `/codex-minimal-tools` | Show the active model profile and effective capabilities. |
| `/codex-minimal-tools:doctor` | Show config/catalog diagnostics. |
| `/fast [on\|off\|status]` | Toggle Fast for this session without changing the config default; status shows both values. |
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
  "$schema": "https://unpkg.com/@oai404iao/pi-codex-runtime/config.schema.json",
  "enabled": true,
  "glyphStyle": "unicode",
  "autoEnable": true,
  "webSocketEnabled": true,
  "fastMode": false,
  "imageGeneration": true,
  "imageOutputDir": ".pi/openai-codex-images",
  "imageModel": "gpt-image-2",
  "viewImageWorkspaceOnly": false,
  "deferApplyPatchRendering": false
}
```

| Setting | Meaning |
| --- | --- |
| `enabled` | Enable all package behavior. |
| `glyphStyle` | Use `unicode` or `ascii` UI glyphs. |
| `autoEnable` | Add supported package tools automatically. |
| `webSocketEnabled` | Global Responses WebSocket master switch. Set `false` to force SSE and disable WebSocket prewarm for every model profile. |
| `fastMode` | Default for new sessions; `/fast` saves a session-only selection. Subagents follow the main agent on subsequent requests. Only profiles with `fast` are affected. |
| `imageGeneration` | Global master switch. Set `false` to omit image tools, `/image-gen`, presentation and standalone requests without changing other model behavior. |
| `imageOutputDir` | Generated-image output directory. Relative paths resolve from the workspace root. |
| `imageModel` | Image model used by standalone generation and edits. |
| `viewImageWorkspaceOnly` | Restrict `view_image` to the workspace. |
| `deferApplyPatchRendering` | Use Pi's fallback renderer instead of the streaming patch preview. |

The older model-level keys remain readable for one migration version, but are
deprecated and no longer appear in `config.schema.json`. `imageGeneration` is
the exception: it remains the supported global master switch. See
[Legacy migration](#legacy-migration).

### Per-Model Catalog

Create:

```text
<PI_CODING_AGENT_DIR>/extensions/pi-codex-minimal-tools/models.json
```

Example overriding a bundled model and adding a custom provider/model:

```json
{
  "$schema": "https://unpkg.com/@oai404iao/pi-codex-runtime/models.schema.json",
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
[`model-catalog.md`](model-catalog.md), and editor
validation is provided by [`models.schema.json`](../models.schema.json).

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

- hosted web tools and standalone image tools;
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
    "systemPromptPlacement": "developer",
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
- Lite cannot use hosted `web_search`; choose `standalone` instead.
  Image generation is standalone only in both modes.
- `tools.applyPatch:"custom"` uses the Codex freeform grammar and requires the
  provider shim. `"function"` works as a normal Pi tool.
- `responses.endpoint` is deprecated compatibility for `openai-codex` only:
  `"openai"` uses `/responses`, `"codex"` uses `/codex/responses`, and `"auto"`
  follows the Pi API. Other providers ignore this override and follow their
  Pi-configured `api` and resolved `baseUrl`. This setting never selects credentials.
- `compaction:"responses"` uses `compaction_trigger` through the selected
  SSE/WebSocket transport. `"pi"` keeps Pi summaries. The legacy
  `"responses-compact"` execution mode was removed; old opaque checkpoints
  are preserved, never silently converted to text.

## Request enhancements and endpoint capabilities

These are global keys in
`<agentDir>/extensions/pi-codex-minimal-tools/config.json`:

```json
{
  "codexRequestExtensions": true,
  "endpoint_config": [
    {
      "provider": "openai",
      "baseUrl": "https://api.openai.com/v1",
      "webSearch": ["hosted"],
      "imageGeneration": ["standalone"],
      "compaction": ["responses"]
    }
  ]
}
```

This example is a **user declaration**, not a claim that every account or
endpoint supports these capabilities. There are no automatic capability probes.

### Codex request extensions

`codexRequestExtensions` defaults to `true` for upgrade compatibility. With
`false`, Standard requests keep authentication, custom/function tools, hosted
tool parsing/persistence and standalone execution, but stop generating:

- Codex thread/window/turn/subagent headers and `client_metadata`;
- installation/turn metadata and Codex UUID replacements for the prompt-cache
  key (requests use Pi's session ID instead);
- Lite headers, namespace envelopes and remote-compaction enhancements;
- Codex `originator` defaults on the modern
  `openai-responses` route. Legacy protocol-required headers and WebSocket
  negotiation headers remain.

Standard standalone tools retain their ordinary function declarations rather
than being rewritten to Codex reserved namespaces. Explicit user headers and
payload metadata are not removed. Internal session/subagent identity records
are retained; the switch controls request emission, not historical data deletion.
Switching the flag separates WebSocket/prewarm cache identities.

This is **not** a switch to Pi's entire native stream implementation. The
plugin still handles its tools, replay, display and storage. A Lite profile
cannot silently become Standard: requests fail with a configuration explanation
until you select a Standard profile or re-enable the flag. Native compaction is
disabled while the flag is off. Without a native checkpoint Pi can use text
compaction; existing opaque checkpoints (all supported versions) are preserved
and blocked from incompatible replay or recompaction. Restore the original
profile/endpoint settings or navigate before the checkpoint.

### Endpoint declarations

`endpoint_config` defaults to `[]`. Entries match the exact provider and
**Pi-auth-resolved base URL**, ignoring trailing slashes. Use the API root as
configured in Pi, not a guessed alternate service URL. URLs must not contain
credentials, query strings or fragments. Declarations never change authentication
or routing, and OAuth/API-key requests to the same provider/base URL share the
declaration.

Each optional capability list is an allowlist:

| Key | Allowed values |
| --- | --- |
| `webSearch` | `"hosted"`, `"standalone"` |
| `imageGeneration` | `"standalone"` |
| `compaction` | `"responses"` |

An omitted list inherits the model profile; `[]` disables that capability.
Missing endpoint entries preserve existing profiles. Invalid capability lists
disable only that capability and produce diagnostics. Duplicate endpoint entries
use the first declaration and report a diagnostic.

Lists do **not** select implementations or enable unknown models. Continue
choosing the implementation in the model profile. For example, allowing only
standalone search while the profile selects hosted disables search; it does
not switch to standalone. Denying native compaction never converts an existing
opaque checkpoint to a text placeholder.

Authentication is resolved lazily, with no extra login/refresh probes just to
draw the tool list. Until a request supplies its actual endpoint, tool projection
uses the model profile. Requests enforce the allowlist before sending; after
resolution the tool list reflects that endpoint. `/codex-minimal-tools doctor`
shows whether resolution is pending. Use `/reload` after editing configuration
to refresh declarations and clear transient rejections.

### Explicit unsupported responses

A recognized, explicit protocol rejection disables only the attempted
capability/mode at that provider+endpoint in the current session and emits a
warning. Hosted search rejection does not disable standalone search or images.
The failed operation remains an error; there is no automatic resend with another
mode, model, provider or credential.

Authentication failures, rate limits, transport failures, generic 404/5xx errors
and unsupported subparameters do not prove the capability is unavailable and
do not disable it. Unknown error formats remain ordinary errors. No config file
is rewritten. Transient rejection state is cleared on the next session lifecycle
or reload, so correcting the server/configuration can be retried.

## Built-In Profiles

`openai` is the actively maintained OpenAI provider. Pi's ChatGPT OAuth and
API-key logins both use `openai-responses` at `https://api.openai.com/v1` by
default. OAuth does not redirect requests to the old ChatGPT backend.
`openai-codex` profiles below are frozen, deprecated compatibility entries.
Select `/login openai` and an `openai` model to migrate; the extension never
copies tokens, aliases providers or rewrites session history.

The bundled catalog is based on local Codex commit
`eb9dceba1a2e658142a456c5898836774835616b` from August 12, 2026, with the
Astra profile updated from `ddea03ad049142943bdbf13e937b1d67e8c1ba0c`.

| Models | Responses | Web | Image | Patch | Compaction |
| --- | --- | --- | --- | --- | --- |
| `openai/gpt-6.1-sol` | Lite, auto WS/SSE | standalone text+image | standalone | custom | responses |
| `openai/gpt-6-astra`, `openai/gpt-6-sol`, `openai/gpt-6-luna` | Standard SSE | off | off | custom | Pi |
| `openai-codex/gpt-6-astra` (deprecated) | Lite, auto WS/SSE | standalone text+image | standalone | custom | responses |
| `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna` | Lite, auto WS/SSE | standalone text+image | standalone | custom | responses |
| `gpt-5.5`, `gpt-5.4` | Standard, auto WS/SSE | hosted text+image | standalone | custom | responses |
| `gpt-5.4-mini`, `codex-auto-review` | Standard, auto WS/SSE | hosted text+image | standalone | custom | responses |
| `gpt-5.2` | Standard, auto WS/SSE | hosted text | standalone | custom | responses |
| legacy GPT-5/Codex entries | inherited Standard profile | profile-specific | standalone | custom | responses |
| `gpt-4.1` | Standard SSE | off | standalone | off | Pi |
| `o4-mini` | Standard SSE | off | off | off | Pi |

`openai/gpt-6.1-sol` explicitly inherits `openai/gpt-5.6-sol`, including prewarm,
disabled parallel calls, `view_image: false` and Fast availability with priority
service tier and a 2x cost multiplier. This is a configured compatibility
default, not upstream evidence of Lite entitlement, endpoint access or pricing.
Pi still supplies its descriptor and authentication. Other GPT-6 profiles and
legacy `openai-codex` profiles are unchanged.

The pre-Astra entries include equivalent `openai/...` and
`openai-codex/...` IDs; the latter switch only the endpoint/auth shape to
`codex`. The newer OpenAI GPT-6 Standard profiles are independent of legacy
Lite profiles. They enable local `view_image` based on Pi's image-input metadata
and custom `apply_patch` based on its explicit grammar-tool capability. They
do not enable hosted/standalone endpoints, WebSocket, native compaction or Fast.
See `provenance/pi-openai-0991-gpt6.json`; Pi owns the descriptors and pricing.

### Migrating from legacy Codex profiles

1. Use Pi's `/login openai` to choose ChatGPT OAuth or an API key. Do not copy
   legacy tokens or rename provider keys in `auth.json`.
2. Select the exact `openai` model in `/model`; save the default through Pi if
   desired. The extension does not change your saved model or existing sessions.
3. Keep Pi's API/base URL/authentication in Pi's own `models.json` and credentials
   configuration. Plugin `apiKeyMode`/`responses.endpoint` overrides are legacy
   compatibility only; remove obsolete global request-profile keys if they
   unintentionally override the new profile.
4. Choose remote tool/compaction implementations explicitly in the plugin's
   `models.json` and declare their allowed modes in global `endpoint_config`.
   For example, opting into hosted search for `openai/gpt-6-astra` requires a
   model override with `tools.webSearch: { "implementation": "hosted" }` plus an
   endpoint declaration that permits `"hosted"`. The declaration alone does
   not turn the default-off tool on.
5. Existing opaque checkpoints are bound to their original provider/model/API.
   Continue with the original settings, start a new session, or navigate before
   the checkpoint. Do not edit session JSON to relabel an old checkpoint.
6. Use `/reload`, then `/codex-minimal-tools doctor`. Endpoint projection is
   pending until Pi resolves the request authentication. No real service
   acceptance is implied by successful offline tests.

Pi supplies the Astra model descriptor. The extension composes its stream shim over that provider and does not
replace authentication, streams, or the model catalog.
The descriptor keeps the production default at 272,000 context tokens and
128,000 output tokens. A backend-authorized larger context must be selected
explicitly through Pi's provider `modelOverrides`; the extension does not infer
that entitlement from the Astra slug.

These entries are defaults, not claims that every proxy with the same model
slug supports the protocol. Override or disable a profile for the endpoint
actually in use.

`openai-codex/gpt-6-sol` and `openai-codex/gpt-6-luna` use separately verified
Lite profiles: developer placement, custom patch, standalone web/image,
parallel calls disabled on the wire, and no reasoning summary. Pi 0.87.1 supplies
their descriptors and `off -> none` mapping; no `ultra`, larger context,
pricing multiplier or public-API cache TTL is inferred. Fast mode is disabled.
See `provenance/openai-codex-40eac3ce-sol-luna.json`. Source/fixture verification
does not establish that a particular account can access these endpoints.

## Web Search

`tools.webSearch` supports two implementations:

- `hosted`: rewrites the Pi placeholder to Responses
  `{"type":"web_search"}` and preserves progress, sources, results, and
  citation replay. Standard Responses only.
- `standalone`: exposes `web.run` as a client-executed namespace tool and calls
  the provider's `alpha/search` endpoint. It supports search/image queries,
  open/click/find, PDF screenshots, finance, weather, sports, and time.

Standalone search sends a bounded recent visible conversation tail ending at
the latest user message, resolved Pi authentication, direct-caller settings,
and a filtered active-turn metadata projection. Model profiles accept `mode`
(`cached`, `indexed`, or default `live`), `searchContextSize`, `userLocation`,
`filters.allowedDomains`, and `maxOutputTokens` (default 10,000). These settings
also project onto hosted search where supported. Search rows stay compact by
default and show deduplicated source hosts; expand the tool row to inspect the
raw result text.

## Image Generation

Set global `config.json.imageGeneration` to `false` to disable the entire
generation capability. Per-model `tools.imageGeneration:false` disables only
that profile. Neither setting disables image input or historical image replay.

`tools.imageGeneration` supports:

- `standalone`: `image_gen.imagegen`, backed by the provider's
  `images/generations` and `images/edits` endpoints.

Standalone input follows current Codex:

- required `prompt`;
- optional `transparent_background` (default false, producing an opaque background);
- up to five `referenced_image_paths`; or
- `num_last_images_to_include` from 1 through 5.

Hosted image generation and `directImageApiFallback` were removed. Remove the
fallback setting and explicitly select `standalone` in old user profiles.

Generated PNGs are saved under `imageOutputDir`, mirrored to `latest.png`, and
returned to the model before the saved-path text. `/image-gen` selects any
loaded image-capable model with an enabled catalog profile.

## WebSocket And Compaction

Global `config.json.webSocketEnabled:false` forces `sse` and disables
WebSocket prewarm without changing the selected per-model profile. When it is
`true` (the default), each profile's `responses.transport` and
`responses.websocketPrewarm` values apply.

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

Native compaction stores opaque encrypted state in the Pi session. Version 4
keeps no preceding messages in model context; the raw session/UI history remains.
It preserves other context handlers' changes and lets Pi restore current
system/tool state. Replay requires the same provider, model, API and effective
profile hash. If these change, restore the original configuration or navigate
before compaction: an opaque checkpoint's placeholder is not a usable text summary.

Legacy checkpoints still replay unchanged canonical contexts. If an earlier
context handler transforms a legacy checkpoint, continuation stops rather than
guessing its boundary or restoring filtered content. Run `/compact` on the
original model to migrate it. Failed recompression preserves the old checkpoint.
Treat sessions containing native compaction as sensitive data; older extension
versions cannot replay v4 checkpoints.

## Apply Patch

When `apply_patch` activates, the extension temporarily hides Pi's `edit` and
`write` tools and restores their prior positions after switching away.

The executor supports Codex `@@ class/function` contexts, ordered update
chunks, `*** Move to:`, `*** End of File`, fuzzy matching, CRLF preservation,
and atomic verification before writes. See
[`apply-patch-behavior.md`](../../pi-codex-core/reference/apply-patch-behavior.md).

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
| `apiKeyMode` | Deprecated; ignored outside `openai-codex`. Configure authentication and `api`/`baseUrl` in Pi instead. |
| `webSearchEnabled` | `tools.webSearch` |
| `viewImage` | `tools.viewImage` |
| `applyPatchEnabled` | `tools.applyPatch` |
| `additionalModelIds` | one exact user catalog entry per model |

Move these values to extension `models.json`; legacy projection is intended
only as a transition path. `imageGeneration` is no longer a legacy projection:
it is the supported global gate, while per-model selection stays in
`tools.imageGeneration`.

## Protocol Reference

The [reference index](README.md) documents the Codex snapshot, Responses
Standard/Lite envelopes, namespace tools, WebSocket continuation, custom-tool
streaming/replay, standalone web/image endpoints, compaction, and apply-patch
protocol.

## License and publication status

Project-authored portions are MIT-licensed, copyright 2026 oai404iao.
Third-party material retains its own terms; see
[LICENSE](../LICENSE) and [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md).

The Codex namespace-tool source attribution is recorded in
`provenance/openai-codex-eb9dceba-reserved-tools.json` in runtime and each
capability package. Release eligibility and historical bootstrap evidence remain
in [RELEASING.md](../../../RELEASING.md). Responses Lite is an internal Codex compatibility path,
not an OpenAI-supported public API contract.
