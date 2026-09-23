---
"@oai404iao/pi-code-mode": patch
"@oai404iao/pi-codex-runtime": patch
---

Complete fail-closed required-policy admission, policy readiness and legacy
revocation gates. Close all owner controls before shutdown callbacks, retain
cleanup retries after foreign replacements, and attempt independent cleanup and
native mutation-tool restoration even when another receipt fails.
