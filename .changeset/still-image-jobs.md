---
"@oai404iao/pi-codex-imagegen": patch
---

Cancel background image jobs when their session is replaced or closed. Scope
job status and timers to the registering instance, consume late auth/results,
and suppress stale UI and new writes after cancellation. Already-started
server generation or disk writes cannot be rolled back.
