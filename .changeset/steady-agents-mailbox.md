---
"@oai404iao/pi-subagent": minor
---

Finish the move to a single durable mailbox protocol and one scheduling mode.

`reportDelivery` and the parent-wakeup path are gone: a child `report` is
recorded in the parent session and never starts or queues a parent turn, so
nothing in this package wakes a parent turn any more. `wait_agent` is the only
way to observe completions. The protocol is no longer versioned — tool details,
descriptions and documentation now say `mailbox` instead of `mailbox-v2`.

Compatibility layers were removed with it: descriptors must be version 4, so
sessions written by earlier releases become a corrupt diagnostic instead of a
resumable child, and the retired settings (`enableRunInBackground`,
`defaultBackground`, `backgroundProtocol`, `syncBundledAgents`,
`reportDelivery`) are rejected as unknown instead of being migrated.
Configuration files are never rewritten; see the migration table in the
package README. `runtimeMode` remains the single scheduling switch.
