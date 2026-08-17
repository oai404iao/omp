# external-thinking

Port of [oh-my-pi](https://github.com/can1357/oh-my-pi)'s `externalThinking`
feature as a [pi](https://github.com/badlogic/pi-mono) extension.

## What it does

oh-my-pi's `externalThinking` replaces a model's opaque native reasoning with
an explicit, visible `think` scratchpad tool:

1. A private `think` tool is registered. It is **hidden from the system
   prompt's tool list** (no `promptSnippet`), but is still sent to the
   provider so the model can call it. In the TUI its arguments are rendered
   as dim, italic text — exactly like the built-in thinking blocks.
2. **Native reasoning is forced off** (`pi.setThinkingLevel("off")`), so the
   model cannot quietly burn tokens on hidden reasoning.
3. In **hard mode** (default) the **first provider request of every user
   prompt pins `tool_choice` to `think`** (OpenAI Responses / Anthropic /
   Google payloads are rewritten in `before_provider_request`), so the model
   *must* think out loud before it does anything else. In **soft mode**
   `tool_choice` is left unset — the think tool is available, but the model
   decides whether to call it. The think result is a private `------` marker
   — the thoughts are not duplicated back into the model's context.

Why it's useful:
- Full visibility: you see exactly what the model reasoned, in the theme's
  `thinkingText` color, instead of collapsed native thinking.
- Works with `reasoning: false` models (cheap "thinking" via a tool call).
- Gives you control: reasoning is a separate, optional channel you can turn
  off at any time.

## Usage

| Action | Command |
| --- | --- |
| Toggle | `/external-thinking` |
| Enable / disable | `/external-thinking on` / `/external-thinking off` |
| Enable in a specific mode | `/external-thinking on hard` / `/external-thinking on soft` |
| Switch mode (persists) | `/external-thinking mode hard` / `/external-thinking mode soft` |
| Show state | `/external-thinking status` |
| Enable at startup | `pi --external-thinking` |

State persists across restarts in
`<agentDir>/external-thinking.json` (usually `~/.pi/agent/` or
`~/.config/pi/agent/`). The thinking level that was active before enabling is
remembered and restored when the feature is turned off. The mode (hard/soft)
also persists; `pi --external-thinking` and `/external-thinking on` re-use the
last saved mode.

## Hard vs soft mode

- **Hard** (default): `tool_choice` is pinned to the `think` tool on the first
  request of every turn, so the model is forced to call it before doing
  anything else. This guarantees the "think out loud first" behavior, but some
  upstreams reject a forced tool call (e.g. gateways that keep a model in
  thinking mode).
- **Soft**: `tool_choice` is never set and payloads are sent completely
  untouched. The `think` tool is available and described to the model, but
  whether it gets called is up to the model. This works with any upstream that
  accepts the tool definition, at the cost of not *guaranteeing* reasoning
  happens.

## Supported models

External thinking requires that native reasoning can be suppressed, which we
can only guarantee for payloads the extension can rewrite:

- OpenAI Responses family: `openai-responses`, `azure-openai-responses`,
  `openai-codex-responses`
- OpenAI Completions (incl. DeepSeek-style `thinking: {type: "disabled"}`)
- `anthropic-messages`
- Google: `google-generative-ai`, `google-vertex`

Additionally, models that pin the `off` thinking level to `null` (always-on
reasoning models) and reasoning models served via the codex protocol (no
reasoning-off knob; detected from the request payload) are not eligible.

## Pass-through behavior — no interception, no degradation

The extension rewrites the first provider request of each turn
(`tool_choice` pinned to `think`, hard mode only) and sends it straight
through. In soft mode requests are never touched at all. It never detects,
blocks, or degrades anything: if the upstream rejects the forced tool call
(e.g. a gateway that keeps a model in thinking mode), the error comes back
from the provider exactly as-is — that is an upstream limitation, not
something this extension hides or works around.

## How it maps to oh-my-pi's implementation

| oh-my-pi | this extension |
| --- | --- |
| `settings.get("externalThinking")` | persisted `external-thinking.json` + `/external-thinking` command + `--external-thinking` flag |
| `supportsExternalThinking(model)` | `supportsExternalThinking(model)` — same API whitelist; `thinkingLevelMap.off === null` replaces the fork's `thinking.requiresEffort && !thinking.suppressWhenOff` metadata |
| `ThinkTool` (hidden, `intent: "omit"`) | `pi.registerTool({ name: "think", renderShell: "self" })` without `promptSnippet` |
| `toolChoiceQueue.pushOnce(think)` | `before_provider_request` rewrites `tool_choice` / `toolConfig` on the first request of each turn |
| `forceReasoningOff: externalThinking` | `pi.setThinkingLevel("off")` on enable + re-asserted on `thinking_level_select` and `model_select` |
| Think tool renderer (italic `thinkingText` markdown) | `renderCall` → `Markdown` with `getMarkdownTheme()` + `theme.fg("thinkingText", …)` italic |
