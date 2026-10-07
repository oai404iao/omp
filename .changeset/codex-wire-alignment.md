---
"@oai404iao/pi-codex-runtime": major
"@oai404iao/pi-codex-core": major
"@oai404iao/pi-codex-imagegen": major
"@oai404iao/pi-codex-web-search": minor
"@oai404iao/pi-subagent": patch
---

Align Codex request identity, metadata, Responses envelopes, WebSocket prewarm,
search context/policy and image parameters with upstream revision 5a314017.
Preserve Pi authentication and privacy boundaries without fabricating Codex
telemetry or attestation.

Remove hosted image generation, direct Images fallback and unary
`responses-compact` execution. Explicit old configurations require migration;
historical image outputs and opaque compaction replay remain supported.
