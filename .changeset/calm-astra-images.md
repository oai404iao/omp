---
"@oai404iao/pi-codex-runtime": minor
"@oai404iao/pi-codex-core": minor
"@oai404iao/pi-codex-imagegen": minor
"@oai404iao/pi-codex-minimal-tools": minor
---

Add an exact `openai-codex/gpt-6-astra` Responses Lite profile using the model
descriptor supplied by the supported Pi baseline.

Promote `config.json.imageGeneration` to a global generation gate. Disabling it
now omits image tools, background commands, presentation and provider injection,
blocks standalone/direct execution before network I/O, and leaves all unrelated
model-profile behavior unchanged.
