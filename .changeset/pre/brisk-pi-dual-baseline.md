---
"@oai404iao/pi-external-thinking": patch
"@oai404iao/pi-codex-minimal-tools": patch
"@oai404iao/pi-codex-runtime": patch
"@oai404iao/pi-codex-core": patch
"@oai404iao/pi-codex-web-search": patch
"@oai404iao/pi-codex-imagegen": patch
"@oai404iao/pi-keep-defaults": patch
"@oai404iao/pi-subagent": patch
"@oai404iao/pi-telegram-notify": patch
---

Pin the supported-package development baseline to Pi 0.85.1 while retaining
the Pi 0.84.2 peer floor. Add full floor/target compatibility verification,
including independently installed Codex tarballs and real-loader checks.
The private tree-continue hook remains exact-0.84.2 and disabled under the target
loader. No Codex catalog, protocol, default capability or publication eligibility
is changed.
