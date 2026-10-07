---
"@oai404iao/pi-subagent": major
---

Replace the previous subagent runtime with an asynchronous Codex multi-agent v2
agent tree and six shared plaintext tools: spawn_agent, send_message,
followup_task, wait_agent, interrupt_agent and list_agents.

BREAKING CHANGE: remove subagent/subagent_fork, child report, foreground mode,
old descriptor resume, UUID/dot-navigation targets and obsolete configuration.
followup_task now requires its own message; wait_agent observes inbox activity
without returning completion contents. Default spawn history is all completed
turns. Rename maxConcurrentBackgroundRuns to maxConcurrentAgents.

Persist identities and mailboxes independently of SDK residency, deliver messages
at safe context boundaries, enforce tree-wide admission and nested tool ceilings,
propagate project trust, preserve cold-resume identity and add recovery/race tests.
Track Codex at 551bd409ebf03fc6ea0dcad0915368d8a493f012 without rewriting historical
protocol provenance.
