---
"@oai404iao/pi-codex-runtime": minor
"@oai404iao/pi-codex-core": minor
"@oai404iao/pi-codex-minimal-tools": minor
---

Add the global `webSocketEnabled` setting. It defaults to `true`; setting it to
`false` forces Responses SSE and disables WebSocket prewarm across model
profiles without changing their catalog values.

Remove deprecated per-model compatibility keys from `config.schema.json`.
Their one-version runtime migration remains available, but new configuration
and editor completion now expose only supported global settings.
