---
"@oai404iao/pi-codex-core": patch
"@oai404iao/pi-codex-runtime": patch
"@oai404iao/pi-codex-tools": patch
---

Honor a retryable WebSocket error's full Retry-After before handing it to Pi to retry. Align Codex tool declarations and image guidance with Pi codemode, and report tool outcomes to Pi without changing Responses replay fields.

Match Codex's hosted web search declaration and omit extra response includes. Set `webSearch.mode` in `config.json` to choose the shared default for hosted and standalone search (`live` when omitted). Only standalone search supports a model-level override.
