# pi-codex-minimal-tools

Minimal Codex/OpenAI tools for Pi. It preserves Pi's native tools except that
GPT-5-series models on the `openai` provider use `apply_patch` instead of
`edit` and `write`.

## Highlights

- `image_generation` — Codex/OpenAI Responses image generation bridge, with saved local outputs.
- `view_image` — return a local image as model image content (off by default).
- `apply_patch` — local Codex-style patch application, with function transport by default and opt-in Codex freeform custom transport.
- `web_search` — hosted OpenAI Responses web search for GPT-5-series `openai` and `openai-codex` models (off by default).
- `/image-gen <prompt> [reference.png]` — background image generation/editing with a live status card.
- Generated images are saved with timestamp filenames, `latest.<ext>` mirrors, metadata, and inline previews.
- Tools only activate on supported OpenAI/Codex-like models; native hosted tools and request profiles are supported on `openai` and `openai-codex`.
- Responses web-search progress events render as compact `Searching the web` / `Searched the web` activity rows.
- Web search citations are preserved as clickable Markdown links when the provider returns citation annotations.
- Optional direct OpenAI Images API fallback when `OPENAI_API_KEY` is set.

## Protocol reference

The [`reference/`](reference/README.md) directory documents the OpenAI Codex
Responses modes, `apply_patch` wire protocols, Responses Lite request shape,
custom-tool streaming parser, history replay, and model tool-exposure modes
used as the source material for this extension's provider work.

## Install

Install as a local Pi package:

```bash
pi install /absolute/path/to/pi-codex-minimal-tools
```

Restart Pi or run `/reload` after installation.

## Commands

| Command | Action |
| --- | --- |
| `/codex-minimal-tools` | Show current status and config path. |
| `/codex-minimal-tools:doctor` | Run self-checks. |
| `/image-gen <prompt> [reference.png]` | Background image generation/editing. |

`/image-gen` uses Codex/ChatGPT OAuth headers from Pi's model registry by default. With `apiKeyMode` enabled it uses plain `Authorization: Bearer <api key>` auth instead and skips ChatGPT account-id headers. It does **not** require `OPENAI_API_KEY` unless you enable the separate direct Images API fallback. Reference images may be `@reference.png` or bare local PNG/JPEG/WebP paths.

## Configuration

This package is configured by a standalone JSON file under Pi's agent directory:

```text
<PI_CODING_AGENT_DIR>/extensions/pi-codex-minimal-tools/config.json
```

If `PI_CODING_AGENT_DIR` is not set, the extension looks under the Pi user agent directory (normally `~/.config/pi/agent` or `~/.pi/agent`, depending on your Pi installation).

All keys are optional. Add `$schema` to enable validation and completion in
JSON Schema-aware editors. `requestProfile` is the only nested section:

```json
{
  "$schema": "https://unpkg.com/pi-codex-minimal-tools@1/config.schema.json",
  "enabled": true,
  "glyphStyle": "unicode",
  "autoEnable": true,
  "nativeProviderTools": true,
  "requestProfile": {
    "responsesMode": "standard",
    "systemPromptPlacement": "instructions",
    "patchTransport": "function",
    "supportsHostedTools": true,
    "supportsParallelTools": true
  },
  "apiKeyMode": false,
  "imageGeneration": true,
  "webSearchEnabled": false,
  "imageOutputDir": ".pi/openai-codex-images",
  "imageModel": "gpt-image-2",
  "directImageApiFallback": false,
  "viewImage": false,
  "viewImageWorkspaceOnly": false,
  "applyPatchEnabled": true,
  "allowAbsolutePatchPaths": false,
  "deferApplyPatchRendering": false
}
```

The schema is shipped with the package as [`config.schema.json`](config.schema.json).
For offline completion, replace the URL with a local path your editor can resolve.

### General

| Setting | What it does |
| --- | --- |
| `enabled` | Register this package's tools and provider shim. |
| `glyphStyle` | UI glyphs: `unicode` or `ascii`. |
| `autoEnable` | Auto-add this package's enabled tools on supported models. |

### Provider

| Setting | What it does |
| --- | --- |
| `nativeProviderTools` | Rewrite this package's hosted-tool placeholders into OpenAI Responses native tools on `openai` and `openai-codex` (`image_generation`, and `web_search` when enabled). |
| `requestProfile` | Explicit Responses capability overrides. `responsesMode` accepts `standard` or `lite`; `systemPromptPlacement` chooses top-level `instructions` or an input `developer` message in Standard mode; `patchTransport` accepts `function` or `custom` and defaults to `function`. `supportsHostedTools` controls hosted-tool activation/rewriting and `supportsParallelTools` controls the request's parallel-call flag. Lite always uses a developer message and forces hosted and parallel tools off. |
| `apiKeyMode` | Use plain `Authorization: Bearer <api key>` auth for `openai-codex` requests and skip ChatGPT account-id extraction/header injection. In this mode, provider `baseUrl` is treated like an OpenAI Responses endpoint root: `/v1` becomes `/v1/responses`, while `/v1/responses` is used as-is. The `openai` provider always uses this API-key transport. |
| `webSearchEnabled` | Expose hosted `web_search` on GPT-5-series `openai` and `openai-codex` models. Disabled by default. |

Responses Lite uses Codex-internal request fields and transport signals. Enable
`requestProfile.responsesMode: "lite"` only for an endpoint known to implement
that contract. Both patch transports work in Lite; this package does not
implement Codex Code Mode.

Set `requestProfile.patchTransport: "custom"` to send `apply_patch` as the
Codex freeform custom tool with the packaged Lark grammar. Other tools remain
normal function tools.

Set `requestProfile.systemPromptPlacement: "developer"` to place Pi's system
prompt at the start of Standard Responses `input`. The default `"instructions"`
keeps it in the top-level `instructions` field.

### Images

| Setting | What it does |
| --- | --- |
| `imageGeneration` | Expose `image_generation` on supported OpenAI Codex image-capable models. |
| `imageOutputDir` | Where generated images are saved. Relative paths resolve against the workspace root. |
| `imageModel` | Image model for native/fallback image generation. |
| `directImageApiFallback` | Allow direct OpenAI Images API generation when native Codex generation is unavailable. |
| `viewImage` | Expose `view_image` on image-capable models. |
| `viewImageWorkspaceOnly` | Reject `view_image` paths outside the workspace. |

### Patch

| Setting | What it does |
| --- | --- |
| `applyPatchEnabled` | Expose `apply_patch` only on GPT-5-series models from the `openai` provider. When active, Pi's `edit` and `write` tools are hidden; their previous activation is restored after switching away. |
| `allowAbsolutePatchPaths` | Permit absolute paths in `apply_patch`. |
| `deferApplyPatchRendering` | Let Pi's fallback renderer handle display instead of the built-in streaming filesystem preview. Defaults to `false`. |

The executor supports Codex `@@ class/function` contexts, ordered update
chunks, `*** End of File`, and Codex-style fuzzy line matching. It verifies all
actions before writing, preserves CRLF files, refuses Add/Move overwrites, and
rejects cwd escapes including symbolic-link escapes. See
[`reference/apply-patch-behavior.md`](reference/apply-patch-behavior.md) for the
exact behavior and intentional safety differences from Codex.

While patch arguments stream, the built-in renderer consumes completed lines
and previews the currently valid A/M/D actions against files under the active
cwd. Preview reads are throttled to at most once every 500 ms, never mutate the
filesystem, and stop before tool execution begins. Set
`deferApplyPatchRendering: true` to use Pi's fallback tool renderer instead.

## API key mode provider example

When `apiKeyMode` is enabled, configure `openai-codex` in Pi's `models.json` like a Responses-compatible endpoint:

```json
{
  "providers": {
    "openai-codex": {
      "baseUrl": "https://api.example.com/v1",
      "apiKey": "$OPENAI_API_KEY"
    }
  }
}
```

The extension will request `https://api.example.com/v1/responses`.
