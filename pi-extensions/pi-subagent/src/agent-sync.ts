import { createHash, randomUUID } from "node:crypto";
import {
	copyFileSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	readlinkSync,
	renameSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { hostname } from "node:os";
import { basename, dirname, join } from "node:path";

const MANIFEST_VERSION = 1;
const STATE_DIR_NAME = ".pi-subagent";
const MANIFEST_FILE_NAME = "agents-manifest.json";
const BACKUPS_DIR_NAME = "backups";
const LOCK_DIR_NAME = "sync.lock";
const RECLAIM_LOCK_DIR_NAME = "sync.reclaim.lock";
const LOCK_OWNER_FILE_NAME = "owner.json";
const LOCK_RETRY_MS = 25;
const LOCK_TIMEOUT_MS = 30_000;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

interface AgentManifest {
	version: 1;
	packageVersion: string;
	files: Record<string, string>;
}

type ManifestReadResult =
	| { kind: "missing" }
	| { kind: "valid"; manifest: AgentManifest }
	| { kind: "corrupt"; diagnostic: string };

interface BundledAgentFile {
	name: string;
	content: Buffer;
	hash: string;
}

type DestinationKind = "missing" | "file" | "symlink";

interface PlannedAction {
	name: string;
	kind: "install" | "replace" | "remove";
	destination: string;
	destinationKind: DestinationKind;
	content?: Buffer;
	stagedPath?: string;
	backupPath?: string;
}

export interface AgentSyncOptions {
	bundledDir: string;
	agentDir: string;
	packageRoot?: string;
	packageVersion?: string;
}

export interface AgentBackup {
	name: string;
	path: string;
	kind: "file" | "symlink";
}

export interface AgentSyncResult {
	packageVersion: string;
	userAgentsDir: string;
	manifestPath: string;
	installed: string[];
	updated: string[];
	removed: string[];
	preserved: string[];
	backups: AgentBackup[];
	diagnostics: string[];
}

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown, field: string): UnknownRecord {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`${field} must be an object`);
	}
	return value as UnknownRecord;
}

function readPackageVersion(packageRoot: string): string {
	const packagePath = join(packageRoot, "package.json");
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(packagePath, "utf8"));
	} catch (error) {
		throw new Error(
			`${packagePath}: cannot read package version: ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
	}
	const record = asRecord(parsed, packagePath);
	if (typeof record.version !== "string" || record.version.trim().length === 0) {
		throw new Error(`${packagePath}: package version must be a non-empty string`);
	}
	return record.version.trim();
}

function resolvePackageVersion(options: AgentSyncOptions): string {
	if (options.packageVersion) return options.packageVersion;
	if (options.packageRoot) return readPackageVersion(options.packageRoot);
	throw new Error("syncBundledAgents requires packageVersion or packageRoot");
}

function parseManifest(value: unknown, manifestPath: string): AgentManifest {
	const input = asRecord(value, manifestPath);
	if (input.version !== MANIFEST_VERSION) {
		throw new Error(`unsupported manifest version: ${String(input.version)}`);
	}
	if (typeof input.packageVersion !== "string" || input.packageVersion.trim().length === 0) {
		throw new Error("packageVersion must be a non-empty string");
	}
	const rawFiles = asRecord(input.files, "files");
	const files: Record<string, string> = {};
	for (const [name, hash] of Object.entries(rawFiles)) {
		if (
			basename(name) !== name ||
			!name.endsWith(".md") ||
			typeof hash !== "string" ||
			!SHA256_PATTERN.test(hash)
		) {
			throw new Error(`files contains an invalid entry for "${name}"`);
		}
		files[name] = hash;
	}
	return {
		version: MANIFEST_VERSION,
		packageVersion: input.packageVersion.trim(),
		files,
	};
}

function hash(content: Buffer): string {
	return createHash("sha256").update(content).digest("hex");
}

function safeSegment(value: string): string {
	const sanitized = value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
	return sanitized || "unknown";
}

function timestamp(): string {
	return new Date().toISOString().replace(/[:.]/g, "-");
}

function stageFile(filePath: string, content: string | Buffer): string {
	mkdirSync(dirname(filePath), { recursive: true });
	const tempPath = join(
		dirname(filePath),
		`.${basename(filePath)}.tmp-${process.pid}-${randomUUID()}`,
	);
	writeFileSync(tempPath, content);
	return tempPath;
}

function bundledAgentFiles(bundledDir: string): BundledAgentFile[] {
	let entries;
	try {
		entries = readdirSync(bundledDir, { withFileTypes: true });
	} catch (error) {
		throw new Error(
			`${bundledDir}: cannot read bundled agents: ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
	}
	const files = entries
		.filter((entry) => entry.name.endsWith(".md") && (entry.isFile() || entry.isSymbolicLink()))
		.sort((left, right) => left.name.localeCompare(right.name))
		.map((entry) => {
			const content = readFileSync(join(bundledDir, entry.name));
			return { name: entry.name, content, hash: hash(content) };
		});
	if (files.length === 0) throw new Error(`${bundledDir}: no bundled agent definitions were found`);
	return files;
}

function readPreviousManifest(manifestPath: string): ManifestReadResult {
	if (!existsSync(manifestPath)) return { kind: "missing" };
	let content: Buffer | undefined;
	try {
		content = readFileSync(manifestPath);
		const manifest = parseManifest(JSON.parse(content.toString("utf8")), manifestPath);
		return { kind: "valid", manifest };
	} catch (error) {
		const fingerprint =
			typeof content === "undefined"
				? randomUUID().slice(0, 12)
				: hash(content).slice(0, 12);
		const corruptPath = `${manifestPath}.corrupt-${fingerprint}`;
		let preservation = `a copy was preserved at ${corruptPath}`;
		try {
			if (!existsSync(corruptPath)) copyFileSync(manifestPath, corruptPath);
		} catch (backupError) {
			preservation = `the corrupt file could not be copied: ${
				backupError instanceof Error ? backupError.message : String(backupError)
			}`;
		}
		return {
			kind: "corrupt",
			diagnostic:
				`${manifestPath}: invalid manifest; bundled-template initialization was skipped and user/project agents remain available; ${preservation}: ${
					error instanceof Error ? error.message : String(error)
				}`,
		};
	}
}

function sleepSync(milliseconds: number): void {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function processIsAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		return code !== "ESRCH";
	}
}

interface LockOwner {
	pid: number;
	hostname: string;
	token: string;
}

function readLockOwner(lockPath: string): LockOwner | undefined {
	try {
		const owner = asRecord(
			JSON.parse(readFileSync(join(lockPath, LOCK_OWNER_FILE_NAME), "utf8")),
			"lock owner",
		);
		if (
			typeof owner.pid !== "number" ||
			!Number.isSafeInteger(owner.pid) ||
			owner.pid <= 0 ||
			typeof owner.hostname !== "string" ||
			owner.hostname.length === 0 ||
			typeof owner.token !== "string" ||
			owner.token.length === 0
		) {
			return undefined;
		}
		return { pid: owner.pid, hostname: owner.hostname, token: owner.token };
	} catch {
		return undefined;
	}
}

function sameLockOwner(left: LockOwner | undefined, right: LockOwner | undefined): boolean {
	return (
		left !== undefined &&
		right !== undefined &&
		left.pid === right.pid &&
		left.hostname === right.hostname &&
		left.token === right.token
	);
}

function tryReclaimDeadLock(stateDir: string, lockPath: string): boolean {
	const reclaimPath = join(stateDir, RECLAIM_LOCK_DIR_NAME);
	try {
		mkdirSync(reclaimPath);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
		throw error;
	}
	try {
		const observed = readLockOwner(lockPath);
		if (
			!observed ||
			observed.hostname !== hostname() ||
			processIsAlive(observed.pid)
		) {
			return false;
		}
		// Only a dead owner can reach this point, so it cannot release and be
		// replaced between identity revalidation and removal. The reclaim mutex
		// prevents two waiters from reaping different generations concurrently.
		if (!sameLockOwner(observed, readLockOwner(lockPath))) return false;
		rmSync(lockPath, { recursive: true, force: true });
		return true;
	} finally {
		rmSync(reclaimPath, { recursive: true, force: true });
	}
}

function acquireSyncLock(stateDir: string): () => void {
	const lockPath = join(stateDir, LOCK_DIR_NAME);
	const deadline = Date.now() + LOCK_TIMEOUT_MS;
	while (true) {
		const token = randomUUID();
		const owner: LockOwner = { pid: process.pid, hostname: hostname(), token };
		try {
			mkdirSync(lockPath);
			try {
				writeFileSync(
					join(lockPath, LOCK_OWNER_FILE_NAME),
					`${JSON.stringify({ ...owner, createdAt: new Date().toISOString() })}\n`,
				);
			} catch (error) {
				rmSync(lockPath, { recursive: true, force: true });
				throw error;
			}
			let released = false;
			return () => {
				if (released) return;
				released = true;
				if (sameLockOwner(owner, readLockOwner(lockPath))) {
					rmSync(lockPath, { recursive: true, force: true });
				}
			};
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			if (tryReclaimDeadLock(stateDir, lockPath)) continue;
			if (Date.now() >= deadline) {
				const ownerText = JSON.stringify(readLockOwner(lockPath) ?? "unknown owner");
				throw new Error(
					`timed out waiting for pi-subagent agent sync lock: ${lockPath} (${ownerText})`,
				);
			}
			sleepSync(LOCK_RETRY_MS);
		}
	}
}

function destinationKind(filePath: string): { kind: DestinationKind; size?: number } {
	try {
		const stats = lstatSync(filePath);
		if (stats.isSymbolicLink()) return { kind: "symlink" };
		if (stats.isFile()) return { kind: "file", size: stats.size };
		throw new Error(`${filePath}: managed agent destination must be a regular file or symbolic link`);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "missing" };
		throw error;
	}
}

function sameRegularFile(filePath: string, size: number | undefined, content: Buffer): boolean {
	if (size !== content.length) return false;
	return readFileSync(filePath).equals(content);
}

function createBackup(action: PlannedAction, backupDir: string): AgentBackup {
	const backupPath = join(backupDir, action.name);
	if (action.destinationKind === "symlink") {
		symlinkSync(readlinkSync(action.destination), backupPath);
		return { name: action.name, path: backupPath, kind: "symlink" };
	}
	copyFileSync(action.destination, backupPath);
	return { name: action.name, path: backupPath, kind: "file" };
}

function restoreBackup(action: PlannedAction): void {
	if (!action.backupPath) throw new Error(`missing rollback backup for ${action.name}`);
	rmSync(action.destination, { force: true });
	if (action.destinationKind === "symlink") {
		const tempPath = `${action.destination}.rollback-${process.pid}-${randomUUID()}`;
		try {
			symlinkSync(readlinkSync(action.backupPath), tempPath);
			renameSync(tempPath, action.destination);
		} finally {
			rmSync(tempPath, { force: true });
		}
		return;
	}
	const tempPath = `${action.destination}.rollback-${process.pid}-${randomUUID()}`;
	try {
		copyFileSync(action.backupPath, tempPath);
		renameSync(tempPath, action.destination);
	} finally {
		rmSync(tempPath, { force: true });
	}
}

function rollback(committed: PlannedAction[]): string[] {
	const errors: string[] = [];
	for (const action of [...committed].reverse()) {
		try {
			if (action.kind === "install") {
				rmSync(action.destination, { force: true });
			} else {
				restoreBackup(action);
			}
		} catch (error) {
			errors.push(`${action.name}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	return errors;
}

export function syncBundledAgents(options: AgentSyncOptions): AgentSyncResult {
	const packageVersion = resolvePackageVersion(options);
	const userAgentsDir = join(options.agentDir, "agents");
	const stateDir = join(options.agentDir, STATE_DIR_NAME);
	const manifestPath = join(stateDir, MANIFEST_FILE_NAME);
	mkdirSync(userAgentsDir, { recursive: true });
	mkdirSync(stateDir, { recursive: true });
	const releaseLock = acquireSyncLock(stateDir);
	try {
		return syncBundledAgentsLocked(
			options,
			packageVersion,
			userAgentsDir,
			stateDir,
			manifestPath,
		);
	} finally {
		releaseLock();
	}
}

function syncBundledAgentsLocked(
	options: AgentSyncOptions,
	packageVersion: string,
	userAgentsDir: string,
	stateDir: string,
	manifestPath: string,
): AgentSyncResult {
	const diagnostics: string[] = [];
	const manifestRead = readPreviousManifest(manifestPath);
	if (manifestRead.kind === "corrupt") {
		return {
			packageVersion,
			userAgentsDir,
			manifestPath,
			installed: [],
			updated: [],
			removed: [],
			preserved: [],
			backups: [],
			diagnostics: [manifestRead.diagnostic],
		};
	}
	const previous = manifestRead.kind === "valid" ? manifestRead.manifest : undefined;

	// The package copies are initialization templates, not a runtime fallback.
	// Once this package version has been initialized, the user directory is
	// authoritative: edits and deletions must survive every same-version start.
	if (previous?.packageVersion === packageVersion) {
		return {
			packageVersion,
			userAgentsDir,
			manifestPath,
			installed: [],
			updated: [],
			removed: [],
			preserved: [],
			backups: [],
			diagnostics,
		};
	}

	const files = bundledAgentFiles(options.bundledDir);
	const currentNames = new Set(files.map((file) => file.name));
	const preserved: string[] = [];
	const actions: PlannedAction[] = [];

	// Plan the complete first-install or version-change operation before
	// changing any user agent file.
	for (const file of files) {
		const destination = join(userAgentsDir, file.name);
		const destinationState = destinationKind(destination);
		if (destinationState.kind === "missing") {
			actions.push({
				name: file.name,
				kind: "install",
				destination,
				destinationKind: "missing",
				content: file.content,
			});
			continue;
		}

		if (
			destinationState.kind === "file" &&
			sameRegularFile(destination, destinationState.size, file.content)
		) {
			preserved.push(file.name);
			continue;
		}
		actions.push({
			name: file.name,
			kind: "replace",
			destination,
			destinationKind: destinationState.kind,
			content: file.content,
		});
	}

	// Retired bundled presets must not remain silently active. They are backed
	// up like replacements, then removed; unrelated user-defined names remain.
	for (const name of Object.keys(previous?.files ?? {}).sort((left, right) => left.localeCompare(right))) {
		if (currentNames.has(name)) continue;
		const destination = join(userAgentsDir, name);
		const destinationState = destinationKind(destination);
		if (destinationState.kind === "missing") continue;
		actions.push({
			name,
			kind: "remove",
			destination,
			destinationKind: destinationState.kind,
		});
	}

	const manifest: AgentManifest = {
		version: MANIFEST_VERSION,
		packageVersion,
		files: Object.fromEntries(files.map((file) => [file.name, file.hash])),
	};
	const stagedPaths: string[] = [];
	const backups: AgentBackup[] = [];
	let backupDir: string | undefined;
	let manifestStage: string | undefined;
	const committed: PlannedAction[] = [];

	try {
		// Stage every replacement and the manifest first, catching permissions or
		// disk-space failures before any managed destination changes.
		for (const action of actions) {
			if (!action.content) continue;
			action.stagedPath = stageFile(action.destination, action.content);
			stagedPaths.push(action.stagedPath);
		}
		manifestStage = stageFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
		stagedPaths.push(manifestStage);

		const needsBackup = actions.some((action) => action.kind !== "install");
		if (needsBackup) {
			backupDir = join(
				stateDir,
				BACKUPS_DIR_NAME,
				`${timestamp()}-to-${safeSegment(packageVersion)}-${randomUUID().slice(0, 8)}`,
			);
			mkdirSync(backupDir, { recursive: true });
			for (const action of actions) {
				if (action.kind === "install") continue;
				const backup = createBackup(action, backupDir);
				action.backupPath = backup.path;
				backups.push(backup);
			}
		}

		for (const action of actions) {
			if (action.kind === "remove") {
				rmSync(action.destination, { force: true });
			} else {
				if (!action.stagedPath) throw new Error(`missing staged content for ${action.name}`);
				renameSync(action.stagedPath, action.destination);
			}
			committed.push(action);
		}
		renameSync(manifestStage, manifestPath);
		manifestStage = undefined;
	} catch (error) {
		const rollbackErrors = rollback(committed);
		const backupText = backupDir ? ` Backups remain at ${backupDir}.` : "";
		const rollbackText =
			rollbackErrors.length > 0 ? ` Rollback errors: ${rollbackErrors.join("; ")}.` : "";
		throw new Error(
			`failed to synchronize bundled subagents: ${
				error instanceof Error ? error.message : String(error)
			}.${backupText}${rollbackText}`,
		);
	} finally {
		for (const stagedPath of stagedPaths) rmSync(stagedPath, { force: true });
	}

	return {
		packageVersion,
		userAgentsDir,
		manifestPath,
		installed: actions.filter((action) => action.kind === "install").map((action) => action.name),
		updated: actions.filter((action) => action.kind === "replace").map((action) => action.name),
		removed: actions.filter((action) => action.kind === "remove").map((action) => action.name),
		preserved,
		backups,
		diagnostics,
	};
}
