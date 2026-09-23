import hostManifest from "./host-manifest.json" with { type: "json" };

// Hard ceilings. Callers can request smaller cell/observation timeouts.
export const LIMITS = {
	codeBytes: 24 * 1024,
	frameBytes: 1024 * 1024, // accommodates JSON-escaped 128 KiB writes; still hard bounded
	outputBytes: 32 * 1024,
	readBytes: 32 * 1024,
	entries: 200,
	calls: 32,
	maxCells: 4,
	delegateHistory: 4096,
	concurrency: 4,
	queue: 16,
	memoryBytes: 192 * 1024 * 1024,
	executionMs: 300_000,
	watchdogSeconds: 305,
	observeMs: 30_000,
	catalogBytes: 24 * 1024,
	traceBytes: 16 * 1024,
	resultBytes: 64 * 1024,
	writeBytes: 128 * 1024,
	policyMs: 5000,
	idleMs: 5 * 60_000,
} as const;

export const HOST = Object.freeze(hostManifest);

export function errorText(error: unknown): string {
	return (error instanceof Error ? error.message : String(error)).slice(0, 4096);
}
