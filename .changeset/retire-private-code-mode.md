---
"@oai404iao/pi-codex-runtime": patch
"@oai404iao/pi-codex-core": patch
"@oai404iao/pi-codex-web-search": patch
---

Remove integration with the retired private Code Mode extension. Keep Codex
apply_patch and web_search registered as direct Pi tools, and retain native
edit/write restoration and foreign-tool ownership checks.
