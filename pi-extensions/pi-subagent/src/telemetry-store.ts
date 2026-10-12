import { closeSync, fsyncSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import type { RunTelemetryEntry } from "./telemetry.ts";

export interface RunTelemetryRead {
	records: RunTelemetryEntry[];
	error?: string;
}

function validRecord(value: unknown): value is RunTelemetryEntry {
	if (!value || typeof value !== "object") return false;
	const record = value as RunTelemetryEntry;
	if (record.version !== 1 || !["run-start", "run-end"].includes(record.kind) ||
		typeof record.runId !== "string" || !Number.isFinite(record.startedAt) ||
		(record.anchorId !== undefined && record.anchorId !== null && typeof record.anchorId !== "string") ||
		(record.timestamp !== undefined && !Number.isFinite(record.timestamp))) return false;
	if (record.kind === "run-end" && (!Number.isFinite(record.durationMs) || record.durationMs! < 0)) return false;
	if (record.context) {
		const context = record.context;
		if (!Number.isFinite(context.contextWindow) || context.contextWindow <= 0 ||
			!Number.isFinite(context.timestamp) ||
			(context.tokens !== null && (!Number.isFinite(context.tokens) || context.tokens < 0)) ||
			(context.percent !== null && (!Number.isFinite(context.percent) || context.percent < 0))) return false;
	}
	return true;
}

/** Read-only: missing/corrupt telemetry never repairs or opens the transcript. */
export function readRunTelemetry(sessionFile: string): RunTelemetryRead {
	try {
		const data = JSON.parse(readFileSync(`${sessionFile}.telemetry.json`, "utf8")) as {
			version?: unknown; records?: unknown;
		};
		if (data?.version !== 1 || !Array.isArray(data.records) || !data.records.every(validRecord)) {
			return { records: [], error: "Unsupported or corrupt subagent telemetry" };
		}
		return { records: data.records };
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { records: [] };
		return { records: [], error: error instanceof Error ? error.message : String(error) };
	}
}

/** The sidecar is isolated from SessionManager's entry/leaf transaction. */
export function writeRunTelemetry(sessionFile: string, records: readonly RunTelemetryEntry[]): void {
	const file = `${sessionFile}.telemetry.json`;
	const staging = `${file}.${randomUUID()}.pending`;
	const fd = openSync(staging, "wx", 0o600);
	try {
		writeFileSync(fd, JSON.stringify({ version: 1, records }) + "\n");
		fsyncSync(fd);
	} finally { closeSync(fd); }
	renameSync(staging, file);
	const directory = openSync(dirname(file), "r");
	try { fsyncSync(directory); } finally { closeSync(directory); }
}
