---
"@oai404iao/pi-codex-runtime": major
"@oai404iao/pi-codex-core": major
"@oai404iao/pi-codex-web-search": major
"@oai404iao/pi-codex-imagegen": major
"@oai404iao/pi-codex-minimal-tools": major
"@oai404iao/pi-subagent": major
"@oai404iao/pi-telegram-notify": major
---

Require Pi 1.2.0; remove support for Pi 0.99.1. Upgrade the host Pi installation
before loading these packages; there is no older-SDK fallback.

Preserve strict child tool ceilings across MCP discovery and cold resumes,
handle custom-run startup and cancellation safely, suppress cancelled
notifications and custom-run Telegram delivery, and align Responses sampling
and core renderer padding with the new SDK contracts.
