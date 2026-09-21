---
"@oai404iao/pi-codex-core": patch
"@oai404iao/pi-code-mode": patch
"@oai404iao/pi-subagent": patch
"@oai404iao/pi-telegram-notify": minor
---

Use Pi 0.86.1's native interfaces: order multi-file mutation locks by canonical
target identity, reject conflicting aliases and identity drift without an unqueued
fallback, contribute stable Code Mode prompt sections,
and enforce child report exclusions at registry creation. Telegram waiting
notifications now follow native blocking-UI events for all extension dialogs,
using their titles rather than tool-name timers or rpiv questionnaire summaries.
