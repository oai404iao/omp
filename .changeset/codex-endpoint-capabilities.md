---
"@oai404iao/pi-codex-runtime": minor
"@oai404iao/pi-codex-core": minor
"@oai404iao/pi-codex-web-search": minor
"@oai404iao/pi-codex-imagegen": minor
"@oai404iao/pi-codex-minimal-tools": minor
---

Add the default-on codexRequestExtensions wire-enhancement gate and exact
provider/auth-resolved-base-URL endpoint_config capability allowlists.
Preserve Standard hosted/standalone tools while blocking incompatible Lite and
opaque-checkpoint transitions. Explicit unsupported protocol responses warn and
disable only the affected mode for the current session/endpoint, with no automatic
provider/implementation fallback or persistent configuration changes.
