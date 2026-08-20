# Third-party notices

## DeepSeek Harness design reference

`@oai404iao/pi-subagent` independently implements Pi extension and SDK
integration. It adapts high-level subagent design concepts—named spawn/fork
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
