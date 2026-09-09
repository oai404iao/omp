---
"@oai404iao/pi-codex-minimal-tools": patch
---

Separate startup prewarm and image display lifecycles from provider registration,
and inject image/web presentation observers instead of importing tool code from
the transport. Existing registration and tools retain their default behavior.

Cancel pending image-display timers and ignore late display callbacks after a
session is replaced. Aborted image capture suppresses new persistence and
completion notifications. Speculative prewarm authentication failures settle
without leaking unhandled rejections or forcing HTTP fallback, and reset releases
prewarm waiters even when an authentication lookup has not finished.
