---
"@oai404iao/pi-codex-minimal-tools": patch
"@oai404iao/pi-codex-runtime": patch
"@oai404iao/pi-codex-core": patch
"@oai404iao/pi-codex-web-search": patch
"@oai404iao/pi-codex-imagegen": patch
---

Split Codex ownership into a non-registering runtime library and independent core,
web-search and image-generation packages. Retain the existing package name and
subagent-inline entry as compatibility composition paths. Share capability and
identity lifecycles through a version-checked session broker so equivalent package
installations do not duplicate providers, tools, commands or renderers.

New packages remain private/blocked. Release artifact preparation now rejects
bundles with unpublished workspace dependencies; this change does not authorize
their bootstrap or publication. Runtime versions must match when composing
packages. Hosted capabilities still require core; standalone clients retain the
existing catalog, Pi authentication, configuration paths and opt-in fallbacks.
