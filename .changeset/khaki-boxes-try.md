---
"@oai404iao/pi-subagent": minor
---

Prepare the optional Codex inline integration before exposing subagent tools, then inject the ready factory into each child to avoid concurrent cold-import races. Depend directly on the exact Codex runtime adapter instead of the full compatibility bundle, preserving optional absence, identity gates and Fast lifecycle behavior while reporting broken adapters as failures.
