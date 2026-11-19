---
"@oai404iao/pi-codex-core": patch
"@oai404iao/pi-codex-runtime": minor
"@oai404iao/pi-codex-minimal-tools": patch
---

- Fall back to SSE on an early WebSocket size rejection when auto transport and endpoint policy allow it. Preserve Retry-After advice from both Responses error event shapes, and count retained media toward native compaction's history budget.
- Add exact Standard SSE profiles for `openai/gpt-6.2-astra` and `openai/gpt-6.2-sol`. Pi must provide the model descriptors; the extension does not register either model.
