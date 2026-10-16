---
"@oai404iao/pi-subagent": minor
---

Isolate child model runtimes so inherited provider registrations cannot overwrite
parent/sibling callbacks or leave a disposed child's extension context in use.
Preserve root custom/native providers, virtual routes, resolved catalogs and
runtime credentials; inherited extensions recreate local registrations. Nested
children use the root baseline instead of transient intermediate registrations.
