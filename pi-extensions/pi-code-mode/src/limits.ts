// Hard ceilings. Callers can request smaller cell/observation timeouts.
export const LIMITS = {
	codeBytes: 24 * 1024,
	frameBytes: 1024 * 1024, // accommodates JSON-escaped 128 KiB writes; still hard bounded
	outputBytes: 32 * 1024,
	readBytes: 32 * 1024,
	entries: 200,
	calls: 32,
	concurrency: 4,
	queue: 16,
	memoryBytes: 192 * 1024 * 1024,
	executionMs: 300_000,
	watchdogSeconds: 305,
	observeMs: 30_000,
	catalogBytes: 24 * 1024,
	resultBytes: 64 * 1024,
	writeBytes: 128 * 1024,
	policyMs: 5000,
	idleMs: 5 * 60_000,
} as const;

export const HOST = {
	release: "rust-v0.145.0",
	source: "25af12f7e61572b0bc18ddb1008be543b91519b0",
	url: "https://github.com/openai/codex/releases/download/rust-v0.145.0/codex-code-mode-host-x86_64-unknown-linux-musl.tar.gz",
	archiveSha256: "ac23177956c30cc1f9f180c27bd80f5bb5b76780db55fb94dcc22644d490852e",
	sha256: "60bf16414be5333f09ff082540082304c7352931ef64bdeb170d4c35a82e6ef8",
	bytes: 46_139_288,
} as const;

export function errorText(error: unknown): string {
	return (error instanceof Error ? error.message : String(error)).slice(0, 4096);
}
