# Third-party notices

## OpenAI Codex multi-agent v2

The current implementation independently adapts the six-tool contracts and
runtime concepts from [OpenAI Codex](https://github.com/openai/codex) at
[`551bd409ebf03fc6ea0dcad0915368d8a493f012`](https://github.com/openai/codex/commit/551bd409ebf03fc6ea0dcad0915368d8a493f012).
The upstream work is Apache-2.0 licensed, Copyright OpenAI.

The Pi implementation has its own TypeScript runtime, persistence format,
plaintext schemas/descriptions and SDK lifecycle integration; no Rust source
file is copied. Changes from the reference include removal of encrypted
arguments, canonical completed-context inheritance, transcript receipts,
registered-agent listing and omission of durable sleep. See
[`provenance/openai-codex-551bd409-multi-agent-v2.json`](provenance/openai-codex-551bd409-multi-agent-v2.json)
for immutable source hashes and the exact license/notice identifiers.

Upstream [`LICENSES/Apache-2.0.txt`](LICENSES/Apache-2.0.txt) and
[`LICENSES/OpenAI-Codex-NOTICE.txt`](LICENSES/OpenAI-Codex-NOTICE.txt) are included.

## Historical DeepSeek Harness design reference

`@oai404iao/pi-subagent` independently implements Pi extension and SDK
integration. Earlier versions adapted high-level subagent design concepts—named spawn/fork
providers, isolated child sessions, continuable children, and model-facing
control tools—from the public
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) subagent
documentation at revision
[`4d03472cd098dc48a630e526ca620f4f37f18a0e`](https://github.com/deepseek-ai/deepseek-harness/commit/4d03472cd098dc48a630e526ca620f4f37f18a0e).

No DeepSeek Harness source file is included in this package. The local
implementation has different runtime APIs, persistence format, provider
boundary, and test fixtures.

DeepSeek Harness is MIT-licensed:

```text
Copyright (c) 2026 DeepSeek
```

The verified upstream license snapshot is preserved in
[`LICENSES/DeepSeek-Harness-MIT.txt`](LICENSES/DeepSeek-Harness-MIT.txt).
The immutable revision, blob identifiers, raw URLs, and SHA-256 checksums for
the source document and license are recorded in
[`provenance/deepseek-harness-4d03472.json`](provenance/deepseek-harness-4d03472.json).
