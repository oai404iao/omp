---
"@oai404iao/pi-external-thinking": patch
"@oai404iao/pi-codex-minimal-tools": patch
"@oai404iao/pi-codex-core": patch
"@oai404iao/pi-codex-web-search": patch
"@oai404iao/pi-codex-imagegen": patch
"@oai404iao/pi-keep-defaults": patch
"@oai404iao/pi-subagent": patch
"@oai404iao/pi-telegram-notify": patch
---

Expose each Pi extension through a package-root `index.ts` facade so compact
startup summaries show the package name without an internal `:src` suffix.
Package resource filters that explicitly selected `src/index.ts` must select
`index.ts` instead.
