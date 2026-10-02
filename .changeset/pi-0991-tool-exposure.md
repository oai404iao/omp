---
"@oai404iao/pi-codex-runtime": minor
"@oai404iao/pi-codex-core": minor
"@oai404iao/pi-codex-web-search": minor
"@oai404iao/pi-codex-imagegen": minor
"@oai404iao/pi-codex-minimal-tools": minor
"@oai404iao/pi-subagent": minor
"@oai404iao/pi-telegram-notify": minor
"@oai404iao/pi-external-thinking": minor
---

Require Pi 0.99.1. Keep hosted Codex tools, image viewing, and all subagent
delegation/control tools model-only; allow active standalone Codex tools through
native codemode. Follow model changes without reactivating manually disabled
tools, and reject hosted placeholder execution as an error. Handle Pi's explicit
prompt dispositions without accepting a handled input as a child task.

The private tree-continue hook remains disabled on this unaudited Pi version.
This does not enable codemode/MCP, add model profiles, or change authentication.
