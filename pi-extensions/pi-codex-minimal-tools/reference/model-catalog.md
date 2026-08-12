# Model catalog and standalone Codex extensions

This extension resolves Codex behavior from an exact per-model catalog. It
does not enable protocol features from model-name prefixes.

## Files and responsibilities

Pi's agent `models.json` owns provider/model connectivity:

- provider ID and model ID;
- `api`;
- base URL;
- authentication and headers;
- input modalities;
- context/token limits and pricing.

The extension catalog owns Codex behavior:

```text
<PI_CODING_AGENT_DIR>/extensions/pi-codex-minimal-tools/models.json
```

It must not be used to define credentials or model registry metadata.

## Resolution algorithm

The catalog format is:

```json
{
  "version": 1,
  "models": []
}
```

Resolution proceeds as follows:

1. Load the packaged catalog.
2. Parse the user catalog.
3. Deep-merge a same-ID user entry over the packaged entry.
4. Resolve `extends` recursively.
5. Apply the temporary legacy-config projection, when an old key is explicitly
   present.
6. Apply protocol normalization and safety constraints.
7. Hash the effective profile.

IDs are normalized for exact case-insensitive lookup. Objects merge
recursively. Arrays and primitive values replace inherited values.

Duplicate user IDs, malformed entries, missing parents, inheritance cycles,
and unknown fields are diagnostics. Missing/cyclic entries do not activate.

## Safe defaults

A user-added profile that does not inherit anything starts with:

```json
{
  "enabled": true,
  "responses": {
    "providerShim": false,
    "endpoint": "auto",
    "mode": "standard",
    "systemPromptPlacement": "instructions",
    "transport": "sse",
    "websocketPrewarm": false
  },
  "tools": {
    "parallelCalls": true,
    "applyPatch": false,
    "webSearch": false,
    "imageGeneration": false,
    "viewImage": false
  },
  "compaction": "pi",
  "fast": false
}
```

This prevents an incomplete profile from silently enabling an internal wire
contract.

## Provider shim binding

`responses.providerShim:true` is active only when Pi's resolved model uses:

```text
openai-responses
openai-codex-responses
```

The extension registers its stream handler for the selected provider without
supplying URL, auth, headers, or models. Newer Pi versions therefore compose
the handler over the user's provider; older Pi versions dispatch it by the
Responses API type.

If the API does not match, hosted tools, custom `apply_patch`, native
compaction, and Fast are disabled. Standalone web/image and function
`apply_patch` do not require the provider shim.

## Responses modes

Standard mode uses top-level `instructions` and `tools`, unless
`systemPromptPlacement:"developer"` is selected.

Lite mode:

- inserts `additional_tools` first;
- groups ordinary function/custom tools in namespace `functions`;
- exposes standalone search as `web.run`;
- exposes standalone image generation as `image_gen.imagegen`;
- omits top-level `instructions` and `tools`;
- forces `parallel_tool_calls:false`;
- sets `reasoning.context:"all_turns"`;
- removes input-image `detail`;
- adds the Lite HTTP header or WebSocket metadata signal.

The stream parser maps namespaced calls back to Pi tool names and stores the
wire namespace/name in `thoughtSignature` so later full-context requests replay
the original provider item.

## Web search implementations

Hosted search serializes as Responses `type:"web_search"`. The profile's
`contentTypes` becomes `search_content_types`. The provider request includes:

```json
[
  "reasoning.encrypted_content",
  "web_search_call.action.sources",
  "web_search_call.results"
]
```

Standalone search calls `alpha/search` through the active provider. Its model
schema mirrors Codex `SearchCommands`: search/image query, open, click, find,
PDF screenshot, finance, weather, sports, time, and response length.

The request includes:

- session ID;
- active model ID;
- a bounded recent visible conversation tail;
- commands;
- direct-caller and live-web settings;
- a response token budget derived from `response_length`.

## Image implementations

Hosted image generation is the Responses `image_generation` tool.

Standalone image generation calls `images/generations` or `images/edits` with
current Codex defaults:

```json
{
  "model": "gpt-image-2",
  "background": "auto",
  "quality": "auto",
  "size": "auto"
}
```

Edit images are sent as data URLs. Sources can be explicit local paths or the
latest one through five conversation images. Requests carry
`x-codex-image-turn-id`.

## Endpoint and authentication shape

`responses.endpoint` controls URL/auth semantics:

- `openai`: API-key style `/responses`, `/alpha/search`, and `/images/...`.
- `codex`: ChatGPT/Codex `/codex/responses`, `/codex/alpha/search`, and
  `/codex/images/...`, with account headers when needed.
- `auto`: `codex` for `openai-codex`, otherwise `openai`.

Authentication is always resolved by Pi. The extension accepts an API key,
resolved Authorization/API-key headers, or actor authorization. Explicit
Pi-resolved headers take precedence over model-header fallbacks.

## Profile identity

The effective profile hash is included in:

- WebSocket connection/cache keys;
- sticky WebSocket-to-SSE fallback keys;
- new native-compaction session details.

Changing protocol behavior therefore cannot reuse a continuation or opaque
checkpoint created under a different profile.

## Source snapshot

The implementation was checked against local Codex commit
`eb9dceba1a2e658142a456c5898836774835616b` dated August 12, 2026, especially:

- `codex-rs/core/src/client.rs`
- `codex-rs/tools/src/tool_spec.rs`
- `codex-rs/tools/src/responses_api.rs`
- `codex-rs/ext/web-search/`
- `codex-rs/ext/image-generation/`
- `codex-rs/codex-api/src/endpoint/`
- `codex-rs/models-manager/models.json`
