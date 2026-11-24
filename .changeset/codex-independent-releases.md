---
"@oai404iao/pi-codex-runtime": patch
"@oai404iao/pi-codex-core": patch
"@oai404iao/pi-codex-tools": patch
"@oai404iao/pi-codex-web-search": patch
"@oai404iao/pi-codex-imagegen": patch
"@oai404iao/pi-codex-minimal-tools": patch
"@oai404iao/pi-subagent": patch
---

Allow compatible Codex packages to be updated independently. The runtime broker
recognizes compatible runtime copies; consumers declare numeric compatibility
ranges beginning with this generation instead of requiring identical package versions.
