---
"@oai404iao/pi-subagent": minor
---

Make bundled agent presets initialization-only. Templates are copied to the
user agent directory on first startup and package-version changes, while
runtime discovery now uses only user and trusted project definitions.
Same-version user deletions remain authoritative, so deleting every role leaves
no available subagents.
