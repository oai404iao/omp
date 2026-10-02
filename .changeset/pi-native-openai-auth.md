---
"@oai404iao/pi-codex-runtime": minor
"@oai404iao/pi-codex-core": minor
"@oai404iao/pi-codex-web-search": minor
"@oai404iao/pi-codex-imagegen": minor
"@oai404iao/pi-codex-minimal-tools": minor
---

Follow Pi's native OpenAI authentication and API routing, including ChatGPT OAuth
request-field compatibility and resolved base URLs for auxiliary requests.
Treat openai-codex as deprecated compatibility without migrating credentials or
history. Outside that legacy provider, apiKeyMode and responses.endpoint no longer
override Pi's API/base URL. Explicit direct image fallback now uses the selected
provider's Pi authentication instead of a separate environment key/account.
