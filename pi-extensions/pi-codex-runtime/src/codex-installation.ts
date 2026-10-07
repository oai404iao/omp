import { randomUUID } from "node:crypto";
import { mkdirSync, openSync, closeSync, readFileSync, writeFileSync, renameSync, unlinkSync, statSync, fsyncSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { isUuid } from "./codex-identity-types.js";

const CACHE = Symbol.for("@oai404iao/pi-codex/installation/v1");
interface Installation { path: string; id: string }
function cache(): typeof globalThis & { [CACHE]?: Installation } { return globalThis; }
function installationIdPath(): string {
	return process.env.PI_CODEX_INSTALLATION_ID_PATH ?? join(getAgentDir(), "pi-codex-minimal-tools", "installation_id");
}
function persistedId(path: string): string | undefined {
	try {
		const value = readFileSync(path, "utf8").trim();
		return isUuid(value) ? value.toLowerCase() : undefined;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}
function acquireLock(path: string): () => void {
	const lock = `${path}.lock`;
	const started = Date.now();
	const pause = new Int32Array(new SharedArrayBuffer(4));
	for (;;) {
		try {
			const fd = openSync(lock, "wx", 0o600);
			try { writeFileSync(fd, String(process.pid)); } finally { closeSync(fd); }
			return () => unlinkSync(lock);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		}
		try {
			const pid = Number(readFileSync(lock, "utf8"));
			if (Number.isSafeInteger(pid) && pid > 0) {
				try { process.kill(pid, 0); } catch (error) {
					if ((error as NodeJS.ErrnoException).code === "ESRCH") {
						throw new Error(`Stale installation identity lock: ${lock}; remove it after confirming process ${pid} has exited.`);
					}
				}
			} else if (Date.now() - statSync(lock).mtimeMs > 30_000) {
				throw new Error(`Invalid installation lock: ${lock}`);
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
			throw error;
		}
		if (Date.now() - started > 5_000) throw new Error(`Timed out waiting for installation identity lock: ${lock}`);
		Atomics.wait(pause, 0, 0, 10);
	}
}

export function codexInstallationIdFor(_sessionKey?: string): string {
	const path = installationIdPath();
	const known = cache()[CACHE];
	if (known?.path === path) return known.id;
	let id = persistedId(path);
	if (!id) {
		mkdirSync(dirname(path), { recursive: true });
		const release = acquireLock(path);
		try {
			id = persistedId(path);
			if (!id) {
				id = randomUUID();
				const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
				const fd = openSync(temporary, "wx", 0o600);
				try { writeFileSync(fd, `${id}\n`); fsyncSync(fd); } finally { closeSync(fd); }
				try { renameSync(temporary, path); } finally {
					try { unlinkSync(temporary); } catch (error) {
						if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
					}
				}
			}
		} finally { release(); }
	}
	cache()[CACHE] = { path, id };
	return id;
}

export function setCodexInstallationId(value: string): void {
	if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
		throw new Error("Codex installation id must be a UUIDv4");
	}
	cache()[CACHE] = { path: installationIdPath(), id: value };
}
export function resetCodexInstallationId(): void { delete cache()[CACHE]; }
