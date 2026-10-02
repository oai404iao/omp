---
"@oai404iao/pi-codex-core": minor
"@oai404iao/pi-codex-web-search": minor
"@oai404iao/pi-codex-imagegen": minor
"@oai404iao/pi-codex-minimal-tools": minor
"@oai404iao/pi-subagent": minor
---

Provide structured script results for patching, standalone search and image
generation while keeping hosted and subagent tools model-only. Child sessions
load native codemode/tool-search through the inherited builtin policy, preserve
hard registry ceilings and deferred discoveries across cold resumes, and report
nested trace IDs without double-counting usage. Child codemode does not expose
classifier/model calls; built-in MCP is not injected.

Skip speculative prewarm with native codemode/tool-search active. In that state,
use Pi text compaction only without an opaque native checkpoint; otherwise
preserve the checkpoint and refuse recompaction rather than guessing the
request tool projection. Disable both tools and retry on the original model,
or navigate before the checkpoint.
