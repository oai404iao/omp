# @oai404iao/pi-external-thinking

Replace compatible Pi models' native reasoning with a visible `Think`
scratchpad tool.

Compatibility: Pi 0.84.2 or newer; tested against 0.84.2.

> npm identity: `@oai404iao/pi-external-thinking`. This package is currently
> private while its compatibility and public-release review are completed. To
> load it for one run from a local checkout:
>
> ```bash
> pi -e ./pi-extensions/external-thinking
> ```
>
> To install that local package persistently, use:
>
> ```bash
> pi install ./pi-extensions/external-thinking
> ```
>
> After promotion, install it with:
>
> ```bash
> pi install npm:@oai404iao/pi-external-thinking
> ```

## What it does

1. Registers a package-specific tool labelled `Think` whose arguments are rendered as dim, italic,
   **visible** reasoning in the Pi TUI. Do not put secrets or user-sensitive
   data in `thoughts`.
2. Sets Pi's thinking level to `off`, but only after checking that the active
   model actually supports disabling native reasoning.
3. In **hard mode** (the default), forces the first provider request of every
   user turn to call `Think`. In **soft mode**, the tool remains available but
   the model decides whether to call it.

The tool has no `promptSnippet`, so it is omitted from Pi's system-prompt tool
list. It is still sent to the provider and its visible description tells the
model that the scratchpad is shown to the user.

## Usage

| Action | Command |
| --- | --- |
| Toggle | `/external-thinking` |
| Enable / disable | `/external-thinking on` / `/external-thinking off` |
| Enable in a specific mode | `/external-thinking on hard` / `/external-thinking on soft` |
| Switch mode (persists) | `/external-thinking mode hard` / `/external-thinking mode soft` |
| Show state | `/external-thinking status` |
| Enable at startup | `pi --external-thinking` |

State persists in `<agentDir>/external-thinking.json` (normally
`~/.pi/agent/` or `~/.config/pi/agent/`). The prior thinking level is restored
when you turn the feature off.

## Hard vs. soft mode

- **Hard**: Pins `tool_choice` to the package-specific `Think` tool for the
  first request of a user turn. If the provider payload does not contain a
  writable extension-tool definition,
  the extension pauses itself and restores native-thinking settings rather than
  falsely claiming enforcement.
- **Soft**: Does not change `tool_choice`. The model may call `Think`, but is
  not required to do so.

Both modes require a provider API that the extension recognizes and a model
for which Pi reports the `off` thinking level as supported.

## Supported models

The extension supports these Pi provider APIs:

- `openai-responses`
- `azure-openai-responses`
- `openai-completions`
- `anthropic-messages`
- `google-generative-ai`
- `google-vertex`

It refuses to enable for unsupported APIs, models that cannot disable native
reasoning (`thinkingLevelMap.off === null`), sessions where the extension tool
is excluded by `--tools` or user tool settings, and `openai-codex-responses` models whose
protocol cannot provide the required reasoning-off guarantee.

If a persisted/flag-enabled session later selects an incompatible model, the
extension pauses, restores the prior thinking level, and resumes only after a
compatible model is selected.

## Upstream attribution

This is a modified port of
[oh-my-pi](https://github.com/can1357/oh-my-pi)'s `externalThinking` feature.
The exact source revisions and local modification scope are recorded in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## License

This modified port is MIT-licensed and preserves the upstream oh-my-pi
copyright notices. See [LICENSE](LICENSE) and
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
