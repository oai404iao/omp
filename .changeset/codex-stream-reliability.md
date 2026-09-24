---
"@oai404iao/pi-codex-core": patch
"@oai404iao/pi-codex-runtime": patch
---

Fix Codex SSE cancellation after response headers, flush residual EOF frames,
and preserve CRLF/Unicode across chunk boundaries. Reject unsuccessful terminal
responses before emitting done or retaining WebSocket continuation state, and
distinguish output-token limits from other incomplete responses.

Honor explicit SSE maxRetries, Retry-After and maxRetryDelayMs while retaining
the default three retries and non-retryable HTTP error handling. Release retry
sleep abort listeners after settlement.

Account for cache-write tokens and clamp fresh input usage. Backfill late
encrypted reasoning signatures without replacing existing replay data.
Honor injected fetch, provider-scoped proxy environments, cacheRetention none,
and WebSocket connect/idle timeout options. Separate socket reuse by effective
proxy route and keep shared-connection waits independently cancellable.

Fail closed on malformed SSE JSON and stop retrying explicit quota exhaustion,
including streaming compaction errors. Use zstd only when it reduces request
bytes on the exact built-in Codex SSE endpoint; preserve custom endpoint and
WebSocket request encoding.
