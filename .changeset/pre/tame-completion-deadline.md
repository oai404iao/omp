---
"@oai404iao/pi-subagent": patch
---

Keep the wait_agent deadline timer referenced while its result is awaited.
Headless SDK processes must not exit before the timeout resolves. Wake, abort,
shutdown and disposal still release the timer and abort listener.
