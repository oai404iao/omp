---
"@oai404iao/pi-subagent": patch
---

Clarify that mailbox FIFO follows serialized durable append order after target
resolution, not invocation order among concurrent sends. Replace a flaky test's
invocation-order assumption with controlled lookup-order regression coverage.
Runtime behavior, configuration and protocol are unchanged.
