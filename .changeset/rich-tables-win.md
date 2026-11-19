---
"@oai404iao/pi-codex-minimal-tools": major
---

Remove the composition package's `./subagent-inline` re-export. SDK consumers must depend on `@oai404iao/pi-codex-runtime` and import `@oai404iao/pi-codex-runtime/subagent-inline` directly. The default composition entry and existing configuration paths are unchanged.
