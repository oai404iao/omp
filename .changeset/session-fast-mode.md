---
"@oai404iao/pi-codex-runtime": minor
"@oai404iao/pi-codex-core": minor
"@oai404iao/pi-subagent": patch
---

Keep `/fast` selections in the session rather than rewriting the configured
new-session default. Restore selections on resume/reload and branch navigation.
Subagent requests dynamically follow the main agent's Fast selection, including
followups and sessions with OpenAI wire identity disabled.
