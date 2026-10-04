---
"@oai404iao/pi-codex-core": patch
"@oai404iao/pi-codex-runtime": minor
"@oai404iao/pi-codex-minimal-tools": patch
"@oai404iao/pi-subagent": patch
---

Forward raw provider events before Codex SSE/WebSocket normalization and prepare
subagent Codex identity for virtual model selections, preserving identity across
routing changes and cold resumes without adding identity to model context.

Align the default `openai/gpt-6.1-sol` profile with `openai/gpt-5.6-sol`: Lite,
auto transport, prewarm, standalone web/image, custom patch, native compaction
and priority Fast availability with a 2x cost multiplier. Keep other GPT-6 and
legacy Codex profiles unchanged. These defaults do not establish real-account
endpoint access or verified Fast pricing.
