---
"@oai404iao/pi-subagent": patch
---

Increase the default agent mailbox wait from 30 to 120 seconds and recommend
300-second waits for longer tasks instead of frequent short polling. Clarify in
tool descriptions and timeout results that waits end early on activity and
expiring a wait does not cancel agents or indicate task failure.
