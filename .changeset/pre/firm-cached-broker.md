---
"@oai404iao/pi-codex-runtime": patch
---

Apply the broker ABI, runtime-version and shape checks to cached API objects as
well as event-bus discovery. Mixed runtime copies must fail before registering
capabilities even when they receive the same ExtensionAPI instance.
