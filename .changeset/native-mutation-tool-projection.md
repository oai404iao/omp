---
"@oai404iao/pi-codex-runtime": patch
"@oai404iao/pi-codex-core": patch
---

Preserve selected native edit/write tools when apply_patch is active. Hide their
model-facing declarations through Pi's prepareLoadout API instead of physically
deactivating them, so tree navigation, reload and resume retain the user's tool
selection without in-memory restoration receipts. Keep prewarm and compaction
snapshots aligned with the owned patch projection; explicitly disabled tools
remain disabled.
